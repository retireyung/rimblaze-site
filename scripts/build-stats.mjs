#!/usr/bin/env node
// RimBlaze stats service: the nightly build.
//
// Pulls game logs, career totals, bios, awards, all-time leaders and play-by-play from NBA.com,
// then writes the JSON the site reads:
//   data/season.json        season feat leaders, streaks and chases     (homepage · Big nights · Season)
//   data/career.json        milestone watch and career clubs            (homepage · Big nights · Career)
//   data/buckets/<s>.json   every rare bucket of the season             (homepage leaders, player pages)
//   data/players/<id>.json  one file per active player                  (player.html#player-<id>)
//   data/players.json       search index
//   players/<slug>-<id>/index.html  pre-rendered profile pages for search engines
//
// Past seasons are cached in data/cache and never refetched, so after the first run
// a nightly build only touches the current season and players who played since.
//
// Usage: node scripts/build-stats.mjs [--season 2026-27] [--players 203999,1629029] [--skip-pages]

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stats, cdn, rows, seasonFor, seasonList, wikidataBios } from './nba.mjs';
import { renderSite } from './pages.mjs';
import { TEAM_NAMES } from './teams.mjs';
import { feats, featScore, tens, rareBuckets, quarterPoints, isRare, isDeep, isClutch, RULES_VERSION, WATCH_MIN, MILESTONES, nextMilestone, badges } from './feats.mjs';
import { careerIndex } from './career.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data'), CACHE = path.join(DATA, 'cache');
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const SEASON = arg('season') || seasonFor();
const ONLY = (arg('players') || '').split(',').filter(Boolean).map(Number);
const FIRST_LOG_SEASON = '1996-97'; // NBA.com game logs are complete from here on
const HIST_TOP = +(arg('hist-top') || 250); // all-time rank cutoff for retired players' profiles
const DAY = 864e5;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function readJSON(f, dflt = null) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return dflt; } }
async function writeJSON(f, v) { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(v)); }
// Writes a data file only when its contents (ignoring the "updated" stamp) actually changed,
// so frequent runs don't create commits and redeploys for nothing.
async function writeData(f, v) {
  const old = await readJSON(f);
  const strip = o => JSON.stringify({ ...o, updated: null });
  if (old && strip(old) === strip(v)) return false;
  await writeJSON(f, v); return true;
}
async function cached(file, maxAgeMs, fetcher) {
  const f = path.join(CACHE, file), hit = await readJSON(f);
  if (hit && (maxAgeMs === Infinity || Date.now() - hit._at < maxAgeMs)) return hit.v;
  const v = await fetcher(); await writeJSON(f, { _at: Date.now(), v }); return v;
}
const slugify = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- 1. Game logs, every season since 1996-97 ----------
function compactLog(r) {
  const home = /vs\./.test(r.MATCHUP);
  return [r.PLAYER_ID, r.PLAYER_NAME, r.TEAM_ABBREVIATION, String(r.GAME_DATE).slice(0, 10), r.GAME_ID, r.MATCHUP.split(' ').pop(), home ? 1 : 0, r.WL,
    r.PTS | 0, r.REB | 0, r.AST | 0, r.STL | 0, r.BLK | 0, r.FG3M | 0, r.FGM | 0, r.FGA | 0, r.MIN | 0];
}
const expand = ([pid, n, t, date, gameId, opp, home, wl, P, R, A, S, B, tpm, fgm, fga, min], season) =>
  ({ pid, n, t, date, gameId, opp, home: !!home, wl, P, R, A, S, B, tpm, fgm, fga, min, season });

async function gameLogs(season) {
  const fetcher = async () => rows(await stats('leaguegamelog', {
    Counter: 0, Direction: 'ASC', LeagueID: '00', PlayerOrTeam: 'P', Season: season, SeasonType: 'Regular Season', Sorter: 'DATE',
  })).map(compactLog);
  const list = season === SEASON ? await cached(`gamelog-${season}.json`, 10 * 6e4, fetcher) : await cached(`gamelog-${season}.json`, Infinity, fetcher);
  return list.map(r => expand(r, season));
}

// ---------- 2. Rare buckets from play-by-play ----------
async function seasonBuckets(careerIdx) {
  let sched = null;
  for (const f of ['staticData/scheduleLeagueV2_1.json', 'staticData/scheduleLeagueV2.json']) {
    try { sched = await cdn(f); if (sched?.leagueSchedule) break; } catch (e) { log(`schedule ${f}: ${e.message.split(' failed: ').pop()}`); }
  }
  if (!sched?.leagueSchedule) throw new Error('NBA.com schedule unavailable');
  const games = (sched?.leagueSchedule?.gameDates || []).flatMap(gd => (gd.games || []).map(g => ({ ...g, date: gd.gameDate })))
    .filter(g => /^002/.test(g.gameId) && g.gameStatus === 3);
  const out = [], quarters = [];
  let missed = 0;
  for (const g of games) {
    const m = /(\d+)\/(\d+)\/(\d+)/.exec(g.date), date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    try {
      // Only a successful download is cached, so a game that failed tonight is retried tomorrow.
      // Cached per rules version, so a rule change recomputes every game once.
      const res = await cached(`rules-v${RULES_VERSION}/${g.gameId}.json`, Infinity, async () => {
        const pbp = await cdn(`liveData/playbyplay/playbyplay_${g.gameId}.json`);
        if (!pbp) throw new Error('no play-by-play yet');
        const acts = pbp.game.actions || [], G = { ...g, final: true };
        const q = quarterPoints(acts, G);
        return {
          buckets: rareBuckets(acts, G, { careerBefore: pid => careerIdx.before(pid, g.gameId, date) }),
          quarters: Object.entries(q).filter(([, v]) => v.qMax >= 20).map(([pid, v]) => ({ gameId: g.gameId, pid: +pid, date, ...v })),
        };
      });
      res.buckets.forEach(b => out.push({ ...b, date }));
      quarters.push(...res.quarters);
    } catch (e) { missed++; }
  }
  log(`rare buckets: ${out.length} from ${games.length - missed} of ${games.length} final games`);
  return { buckets: out, quarters };
}

// ---------- 3. Helpers over game lines ----------
// Season chases: counted feats and streaks, measured against the best single season since 1996-97.
const CHASES = [
  { key: 'td', label: 'Triple-doubles', test: l => tens(l) >= 3 },
  { key: 'p50', label: '50-point games', test: l => l.P >= 50 },
  { key: 'p40', label: '40-point games', test: l => l.P >= 40 },
  { key: 'p30', label: '30-point games', test: l => l.P >= 30 },
  { key: 'r20', label: '20-rebound games', test: l => l.R >= 20 },
  { key: 'a15', label: '15-assist games', test: l => l.A >= 15 },
  { key: 't8', label: 'Games with 8+ threes', test: l => l.tpm >= 8 },
  { key: 'b5', label: 'Games with 5+ blocks', test: l => l.B >= 5 },
  { key: 'dds', label: 'Double-double streak', streak: true, test: l => tens(l) >= 2 },
  { key: 'p30s', label: '30-point streak', streak: true, test: l => l.P >= 30 },
];
function seasonFeatTotals(lines) {
  const P = new Map();
  const byPlayer = new Map();
  lines.forEach(l => { if (!byPlayer.has(l.pid)) byPlayer.set(l.pid, []); byPlayer.get(l.pid).push(l); });
  for (const [pid, ls] of byPlayer) {
    ls.sort((a, b) => a.date.localeCompare(b.date));
    const r = { pid, name: ls[0].n, team: ls[ls.length - 1].t, gp: ls.length, dd: 0 };
    for (const c of CHASES) { r[c.key] = 0; if (c.streak) r[c.key + 'Best'] = 0; }
    ls.forEach(l => {
      if (tens(l) >= 2) r.dd++;
      for (const c of CHASES) {
        const hit = c.test(l);
        if (!c.streak) { if (hit) r[c.key]++; }
        else { r[c.key] = hit ? r[c.key] + 1 : 0; r[c.key + 'Best'] = Math.max(r[c.key + 'Best'], r[c.key]); }
      }
    });
    r.streak = r.dds; r.bestStreak = r.ddsBest; // names the homepage tables use
    P.set(pid, r);
  }
  return P;
}
const pace = (n, gp, teamGames) => gp ? Math.round(n / Math.max(gp, 1) * Math.max(82 * gp / Math.max(teamGames, gp), gp)) : 0;

// ---------- main ----------
async function main() {
  await mkdir(CACHE, { recursive: true });
  log(`RimBlaze build · season ${SEASON}`);

  // game logs
  const seasons = seasonList(FIRST_LOG_SEASON, SEASON);
  const allLines = [];
  for (const s of seasons) { const l = await gameLogs(s); allLines.push(...l); log(`game log ${s}: ${l.length} lines`); }
  const cur = allLines.filter(l => l.season === SEASON);
  const careerIdx = careerIndex(allLines);
  const linesBy = new Map();
  allLines.forEach(l => { if (!linesBy.has(l.pid)) linesBy.set(l.pid, []); linesBy.get(l.pid).push(l); });

  // season feat records since 1996-97 (for the chases)
  // best single season since 1996-97 for every chase category
  const records = {};
  for (const sz of seasons.filter(x => x !== SEASON)) {
    const T = seasonFeatTotals(allLines.filter(l => l.season === sz));
    for (const r of T.values()) for (const c of CHASES) {
      const v = c.streak ? r[c.key + 'Best'] : r[c.key];
      if (v > 0 && (!records[c.key] || v > records[c.key].v)) records[c.key] = { v, name: r.name, season: sz };
    }
  }

  // active players, all-time ranks
  const active = rows(await stats('commonallplayers', { LeagueID: '00', Season: SEASON, IsOnlyCurrentSeason: 1 }))
    .filter(p => p.ROSTERSTATUS === 1 || p.ROSTERSTATUS === '1').map(p => ({ id: p.PERSON_ID, name: p.DISPLAY_FIRST_LAST, team: p.TEAM_ABBREVIATION, teamName: `${p.TEAM_CITY} ${p.TEAM_NAME}`.trim() }));
  log(`active players: ${active.length}`);
  const grids = await cached(`alltime-${new Date().toISOString().slice(0, 10)}.json`, DAY, async () =>
    stats('alltimeleadersgrids', { LeagueID: '00', PerMode: 'Totals', SeasonType: 'Regular Season', TopX: 1000 }));
  const rank = {};
  [['pts', 'PTSLeaders', 'PTS'], ['reb', 'REBLeaders', 'REB'], ['ast', 'ASTLeaders', 'AST'], ['tpm', 'FG3MLeaders', 'FG3M'], ['stl', 'STLLeaders', 'STL'], ['blk', 'BLKLeaders', 'BLK']]
    .forEach(([k, set, col]) => { rank[k] = new Map(rows(grids, set).map(r => [r.PLAYER_ID, { rank: r[col + '_RANK'], v: r[col] }])); });

  // historical profiles: retired players in the top 250 all-time in points, rebounds or assists
  const activeIds = new Set(active.map(p => p.id)), histMap = new Map();
  [['PTSLeaders', 'PTS'], ['REBLeaders', 'REB'], ['ASTLeaders', 'AST']].forEach(([set, col]) =>
    rows(grids, set).filter(r => r[col + '_RANK'] <= HIST_TOP && !activeIds.has(r.PLAYER_ID))
      .forEach(r => histMap.set(r.PLAYER_ID, { id: r.PLAYER_ID, name: r.PLAYER_NAME, team: '', teamName: '', retired: true })));
  const historical = [...histMap.values()];
  log(`historical players: ${historical.length} (top ${HIST_TOP} in points, rebounds or assists)`);

  // hometown, high school and college from Wikidata (weekly; a failure just leaves those fields empty)
  let bios = new Map();
  try {
    const raw = await cached('wikidata-bios-v3.json', 7 * DAY, async () => [...(await wikidataBios([...active, ...historical].map(p => p.id))).entries()]);
    bios = new Map(raw);
    log(`wikidata bios: ${bios.size} players`);
  } catch (e) { log(`wikidata bios unavailable: ${e.message}`); }

  // rare buckets
  const fullName = new Map([...active, ...historical].map(p => [p.id, p.name]));
  cur.forEach(l => { if (!fullName.has(l.pid)) fullName.set(l.pid, l.n); });
  let rawBuckets = [];
  try {
    const sb = await seasonBuckets(careerIdx);
    rawBuckets = sb.buckets;
    await writeJSON(path.join(DATA, 'quarters', SEASON + '.json'), sb.quarters);
  } catch (e) { log(`rare buckets skipped tonight: ${e.message}`); }
  // 20-point quarters: every season's file (past seasons come from the backfill), onto the game lines
  const qBy = new Map();
  for (const f of (await readdir(path.join(DATA, 'quarters')).catch(() => [])).filter(f => /^\d{4}-\d{2}\.json$/.test(f)))
    for (const q of (await readJSON(path.join(DATA, 'quarters', f), [])) || []) qBy.set(q.gameId + '|' + q.pid, q);
  for (const l of allLines) { const q = qBy.get(l.gameId + '|' + l.pid); if (q) { l.qMax = q.qMax; l.qPer = q.period; } }
  // career totals for the live build's MILESTONE checks
  await writeJSON(path.join(CACHE, 'career-base.json'), careerIdx.compact(active.map(p => p.id), SEASON));
  const buckets = rawBuckets.map(b => ({ ...b, n: fullName.get(b.pid) || b.n }));
  await writeJSON(path.join(DATA, 'buckets', SEASON + '.json'), buckets);

  // every rare bucket on record, past seasons (from the backfill) plus this one, by player, for profiles
  const pastSeasons = (await readdir(path.join(DATA, 'buckets')).catch(() => []))
    .filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).filter(s => s !== SEASON).sort();
  const pastBuckets = new Map(); // season -> list
  for (const s of pastSeasons) pastBuckets.set(s, (await readJSON(path.join(DATA, 'buckets', s + '.json'), [])) || []);
  const bucketsBy = new Map();
  for (const list of pastBuckets.values()) for (const b of list) b.n = fullName.get(b.pid) || b.n; // archived seasons store "S. Curry"
  for (const list of [...pastBuckets.values(), buckets]) for (const b of list) { if (!bucketsBy.has(b.pid)) bucketsBy.set(b.pid, []); bucketsBy.get(b.pid).push(b); }
  log(`rare buckets on record: ${[...bucketsBy.values()].reduce((n, l) => n + l.length, 0)} across ${pastSeasons.length + 1} seasons`);

  // per player
  // Refetch a player's career totals once each time a new game of his shows up in the game log.
  const seenFile = path.join(CACHE, 'seen.json'), firstRun = !existsSync(seenFile);
  const seen = await readJSON(seenFile, {});
  const lastDate = new Map(); cur.forEach(l => { if (!lastDate.has(l.pid) || l.date > lastDate.get(l.pid)) lastDate.set(l.pid, l.date); });
  for (const [pid, d] of lastDate) if (seen[pid]?.date !== d) seen[pid] = { date: d, at: firstRun ? 0 : Date.now() };
  await writeJSON(seenFile, seen);
  const careerFresh = async (id, fetcher) => {
    const f = path.join(CACHE, `career/${id}.json`), hit = await readJSON(f);
    if (hit && hit._at >= (seen[id]?.at || 0) && Date.now() - hit._at < 7 * DAY) return hit.v;
    const v = await fetcher(); await writeJSON(f, { _at: Date.now(), v }); return v;
  };
  const everyone = [...active, ...historical];
  const targets = ONLY.length ? everyone.filter(p => ONLY.includes(p.id)) : everyone;
  const profiles = [];
  let i = 0;
  for (const a of targets) {
    i++; if (i % 50 === 0) log(`players ${i}/${targets.length}`);
    try {
      // Retired careers don't change, so their files are kept for 90 days.
      const keep = a.retired ? 90 * DAY : 7 * DAY;
      const career = a.retired ? await cached(`career/${a.id}.json`, keep, () => stats('playercareerstats', { PlayerID: a.id, PerMode: 'Totals', LeagueID: '00' }))
        : await careerFresh(a.id, () => stats('playercareerstats', { PlayerID: a.id, PerMode: 'Totals', LeagueID: '00' }));
      const info = await cached(`info/${a.id}.json`, keep, () => stats('commonplayerinfo', { PlayerID: a.id, LeagueID: '00' }));
      const awardsRaw = await cached(`awards/${a.id}.json`, keep, () => stats('playerawards', { PlayerID: a.id }));
      profiles.push(buildProfile(a, career, info, awardsRaw, linesBy.get(a.id) || [], bucketsBy.get(a.id) || [], rank, bios.get(a.id)));
    } catch (e) { log(`skip ${a.name}: ${e.message}`); }
  }

  for (const p of profiles) await writeJSON(path.join(DATA, 'players', p.person.id + '.json'), p);
  await writeJSON(path.join(DATA, 'players.json'), profiles.map(p => ({ id: p.person.id, name: p.person.name, active: p.person.active, team: p.person.active ? (p.person.team?.abbr || '') : 'Retired', slug: slugify(p.person.name) + '-' + p.person.id })));

  // season.json
  const T = seasonFeatTotals(cur);
  const teamGames = Math.max(0, ...[...new Set(cur.map(l => l.t))].map(t => new Set(cur.filter(l => l.t === t).map(l => l.gameId)).size));
  const leaders = [...T.values()].filter(r => r.td || r.dd || r.p30).sort((a, b) => b.td - a.td || b.p40 - a.p40 || b.dd - a.dd || b.p30 - a.p30).slice(0, 15);
  const chase = [];
  for (const c of CHASES) {
    const rec = records[c.key]; if (!rec) continue;
    const top = [...T.values()].sort((a, b) => b[c.key] - a[c.key] || a.gp - b.gp)[0];
    const cur = top?.[c.key] || 0; if (!cur) continue;
    const since = `since ${FIRST_LOG_SEASON}: ${rec.v} by ${rec.name} (${rec.season})`;
    chase.push(c.streak
      ? { cat: c.label, pid: top.pid, name: top.name, cur, max: Math.max(cur, rec.v), ratio: cur / rec.v,
          what: `Active ${c.label.toLowerCase()}. Longest in one season ${since}.`,
          need: cur > rec.v ? 'New mark' : (rec.v - cur) + ' to tie', lbl: cur + ' straight' }
      : { cat: c.label, pid: top.pid, name: top.name, cur, max: Math.max(cur, rec.v), ratio: cur / rec.v,
          what: `${c.label} this season. Most in a season ${since}.`,
          need: 'Pace: ' + pace(cur, top.gp, teamGames), lbl: cur > rec.v ? `${cur} · past the mark of ${rec.v}` : `${cur} of ${rec.v}` });
  }
  chase.sort((a, b) => b.ratio - a.ratio);
  const tallyRare = (list, rareBy = new Map()) => {
    list.forEach(b => {
      const r = rareBy.get(b.pid) || { pid: b.pid, name: fullName.get(b.pid) || b.n, team: b.t, rare: 0, logo: 0, buzz: 0, go: 0, deep: 0 };
      r.team = b.t; // seasons are tallied oldest first, so this ends on the latest team
      r.rare++; if (isDeep(b)) r.logo++; if (b.tags.includes('BUZZER')) r.buzz++; if (isClutch(b)) r.go++; r.deep = Math.max(r.deep, b.d || 0);
      rareBy.set(b.pid, r);
    });
    return rareBy;
  };
  const rareBy = tallyRare(buckets);
  // Since tracking began: every season's rare buckets file, oldest first, with this season's fresh list.
  const rareAllBy = new Map();
  let rareSince = null;
  const bucketSeasons = pastSeasons;
  for (const s of [...bucketSeasons, SEASON]) {
    const list = s === SEASON ? buckets : pastBuckets.get(s) || [];
    for (const b of list) if (b.date && (!rareSince || b.date < rareSince)) rareSince = b.date;
    tallyRare(list, rareAllBy);
  }
  const rankRare = m => [...m.values()].sort((a, b) => b.rare - a.rare || b.deep - a.deep).slice(0, 10);
  const teamRare = Object.entries(buckets.reduce((m, b) => (m[b.t] = (m[b.t] || 0) + 1, m), {})).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  await writeData(path.join(DATA, 'season.json'), {
    season: SEASON, updated: new Date().toISOString(), since: FIRST_LOG_SEASON,
    leaders: leaders.map(r => ({ pid: r.pid, name: r.name, team: r.team, td: r.td, dd: r.dd, p30: r.p30, p40: r.p40, streak: r.streak })),
    chase,
    rareLeaders: rankRare(rareBy),
    rareLeadersAll: rankRare(rareAllBy), rareSince,
    teamRare,
  });

  // career.json
  const watch = [];
  const activeProfiles = profiles.filter(p => p.person.active);
  for (const p of activeProfiles) {
    const s = p.seasons.find(x => x.season === SEASON);
    for (const key of Object.keys(MILESTONES)) {
      const curV = p.career[key] || 0, nm = nextMilestone(key, curV);
      if (!nm || !s || !s.gp || nm.goal < WATCH_MIN[key]) continue;
      const avg = (s[key] || 0) / s.gp; if (!avg) continue;
      const eta = Math.ceil(nm.need / avg);
      if (eta <= 12) watch.push({ pid: p.person.id, name: p.person.name, team: p.person.team?.abbr || '', stat: MILESTONES[key].label, cur: curV, base: nm.base, goal: nm.goal, avg: +avg.toFixed(1), eta });
    }
  }
  watch.sort((a, b) => a.eta - b.eta || a.goal - b.goal);
  const clubs = [['pts', 30000], ['pts', 20000], ['reb', 10000], ['ast', 8000], ['tpm', 2000], ['td', 100], ['td', 50]].map(([k, v]) => {
    const inn = activeProfiles.filter(p => (p.career[k] || 0) >= v);
    const next = activeProfiles.filter(p => (p.career[k] || 0) < v).sort((a, b) => (b.career[k] || 0) - (a.career[k] || 0))[0];
    return { club: v.toLocaleString() + ' ' + MILESTONES[k].label, n: inn.length, members: inn.map(p => p.person.name), next: next ? next.person.name : '—', nextPid: next?.person.id, nextNeed: next ? v - (next.career[k] || 0) : null };
  });
  // all-time leaderboards: top 250 in six stats, linked to profiles where we have them
  const profById = new Map(profiles.map(p => [p.person.id, p]));
  const boards = [['pts', 'PTSLeaders', 'PTS', 'Points'], ['reb', 'REBLeaders', 'REB', 'Rebounds'], ['ast', 'ASTLeaders', 'AST', 'Assists'],
    ['tpm', 'FG3MLeaders', 'FG3M', 'Threes'], ['stl', 'STLLeaders', 'STL', 'Steals'], ['blk', 'BLKLeaders', 'BLK', 'Blocks']].map(([key, set, col, label]) => ({
    key, label,
    rows: rows(grids, set).filter(r => r[col + '_RANK'] <= HIST_TOP).sort((x, y) => x[col + '_RANK'] - y[col + '_RANK']).map(r => {
      const p = profById.get(r.PLAYER_ID), isActive = activeIds.has(r.PLAYER_ID);
      // live total for active players (the grid is a day old), and games for per-game averages
      const v = isActive && p ? Math.max(r[col], p.career[key] || 0) : r[col];
      return { rank: r[col + '_RANK'], id: r.PLAYER_ID, name: r.PLAYER_NAME, v, active: isActive, gp: p?.career.gp || null,
        from: p?.person.from || null, to: p?.person.to || null, slug: p ? slugify(p.person.name) + '-' + p.person.id : null };
    }),
  }));
  const alltime = { updated: new Date().toISOString(), top: HIST_TOP, boards };
  await writeData(path.join(DATA, 'alltime.json'), alltime);

  await writeData(path.join(DATA, 'career.json'), { updated: new Date().toISOString(), watch: watch.slice(0, 12), clubs });

  if (!process.argv.includes('--skip-pages')) await renderSite({ root: ROOT, profiles, alltime, slugify, log, cur, buckets, season: SEASON });
  log(`done · ${profiles.length} player files`);
}

// ---------- profile model ----------
function buildProfile(a, careerJ, infoJ, awardsJ, lines, buckets, rank, bio = {}) {
  const info = rows(infoJ, 'CommonPlayerInfo')[0] || {};
  const seasonRows = rows(careerJ, 'SeasonTotalsRegularSeason');
  const bySeason = new Map();
  seasonRows.forEach(r => { const k = r.SEASON_ID; const prev = bySeason.get(k); if (!prev || r.TEAM_ABBREVIATION === 'TOT') bySeason.set(k, { ...r, teams: [...(prev?.teams || []), ...(r.TEAM_ABBREVIATION !== 'TOT' ? [r.TEAM_ABBREVIATION] : [])] }); else prev.teams.push(r.TEAM_ABBREVIATION); });
  const feat = s => { const ls = lines.filter(l => l.season === s); return { td: ls.filter(l => tens(l) >= 3).length, dd: ls.filter(l => tens(l) >= 2).length, p40: ls.filter(l => l.P >= 40).length, logged: ls.length > 0 }; };
  const seasons = [...bySeason.values()].map(r => {
    const f = feat(r.SEASON_ID);
    return { season: r.SEASON_ID, team: r.TEAM_ABBREVIATION === 'TOT' ? r.teams.join('/') : r.TEAM_ABBREVIATION, gp: r.GP, min: r.MIN, pts: r.PTS, reb: r.REB, ast: r.AST, stl: r.STL, blk: r.BLK, tpm: r.FG3M,
      fgm: r.FGM, fga: r.FGA, fg3m: r.FG3M, fg3a: r.FG3A, ftm: r.FTM, fta: r.FTA, td: f.logged ? f.td : null, dd: f.logged ? f.dd : null, p40: f.logged ? f.p40 : null,
      rare: buckets.filter(b => b.date && seasonFor(new Date(b.date + 'T12:00:00')) === r.SEASON_ID).length || null };
  });
  const c = rows(careerJ, 'CareerTotalsRegularSeason')[0] || {};
  const career = { gp: c.GP || 0, pts: c.PTS || 0, reb: c.REB || 0, ast: c.AST || 0, stl: c.STL || 0, blk: c.BLK || 0, tpm: c.FG3M || 0,
    fgm: c.FGM || 0, fga: c.FGA || 0, fg3m: c.FG3M || 0, fg3a: c.FG3A || 0, ftm: c.FTM || 0, fta: c.FTA || 0,
    td: lines.filter(l => tens(l) >= 3).length, dd: lines.filter(l => tens(l) >= 2).length,
    ranks: Object.fromEntries(Object.entries(rank).map(([k, m]) => [k, m.get(a.id)?.rank || null])) };
  const awards = rows(awardsJ, 'PlayerAwards').map(r => ({ name: r.DESCRIPTION === 'All-NBA' || /All-NBA/.test(r.DESCRIPTION) ? 'All-NBA' : r.DESCRIPTION, season: r.SEASON, team: r.TEAM }))
    .filter(r => /Most Valuable|All-Star$|All-NBA|Champion|Defensive Player|Rookie of the Year|Finals Most/.test(r.name) && !/All-Star Most Valuable/.test(r.name));
  const nights = lines.map(l => ({ ...l, feats: feats(l) })).filter(l => l.feats.length)
    .map(l => ({ date: l.date, season: l.season, gameId: l.gameId, opp: l.opp, home: l.home, wl: l.wl, P: l.P, R: l.R, A: l.A, S: l.S, B: l.B, tpm: l.tpm, fgm: l.fgm, fga: l.fga, ...(l.qMax ? { qMax: l.qMax, qPer: l.qPer } : {}), feats: l.feats, score: featScore(l.feats) }));
  const highs = [['P', 'Points'], ['R', 'Rebounds'], ['A', 'Assists'], ['tpm', 'Threes'], ['S', 'Steals'], ['B', 'Blocks']].map(([k, label]) => {
    const best = lines.slice().sort((x, y) => y[k] - x[k] || x.date.localeCompare(y.date))[0];
    return best ? { stat: label, v: best[k], date: best.date, opp: best.opp, home: best.home, gameId: best.gameId, line: { P: best.P, R: best.R, A: best.A } } : null;
  }).filter(Boolean);
  const retired = !!a.retired;
  const logsPartial = +String(info.FROM_YEAR || seasonRows[0]?.SEASON_ID || '9999').slice(0, 4) < +FIRST_LOG_SEASON.slice(0, 4);
  // Splits: this season for active players; every logged game for retired ones.
  const curLines = retired ? lines : lines.filter(l => l.season === SEASON);
  const split = f => { const ls = curLines.filter(f); return { gp: ls.length, ppg: ls.length ? +(ls.reduce((s, l) => s + l.P, 0) / ls.length).toFixed(1) : null, rpg: ls.length ? +(ls.reduce((s, l) => s + l.R, 0) / ls.length).toFixed(1) : null, apg: ls.length ? +(ls.reduce((s, l) => s + l.A, 0) / ls.length).toFixed(1) : null }; };
  const months = retired ? [] : [...new Set(curLines.map(l => l.date.slice(0, 7)))];
  const ddDates = lines.filter(l => tens(l) >= 2).map(l => l.date).sort();
  const profile = {
    updated: lines.reduce((m, l) => l.date > m ? l.date : m, '') || null, season: SEASON, logsSince: FIRST_LOG_SEASON,
    person: {
      id: a.id, name: a.name, first: info.FIRST_NAME, last: info.LAST_NAME, number: info.JERSEY, position: info.POSITION, height: info.HEIGHT, weight: info.WEIGHT,
      birthDate: String(info.BIRTHDATE || '').slice(0, 10), country: info.COUNTRY, from: info.FROM_YEAR, to: info.TO_YEAR,
      hometown: bio?.hometown || null, highSchools: bio?.highSchools || [],
      college: bio?.colleges?.length ? bio.colleges.join(', ') : null,
      lastAttended: info.SCHOOL && info.SCHOOL !== 'None' ? info.SCHOOL : null,
      draft: info.DRAFT_YEAR && info.DRAFT_YEAR !== 'Undrafted' ? { year: info.DRAFT_YEAR, round: info.DRAFT_ROUND, pick: info.DRAFT_NUMBER } : null,
      team: retired ? { abbr: '', name: '' } : { abbr: info.TEAM_ABBREVIATION || a.team, name: `${info.TEAM_CITY || ''} ${info.TEAM_NAME || ''}`.trim() || a.teamName },
      teams: teamSpans(seasons), active: !retired,
    },
    seasons, career, awards, highs, nights: nights.sort((x, y) => y.date.localeCompare(x.date)), ddDates,
    buckets: buckets.map(b => ({ date: b.date, gameId: b.gameId, o: b.o, q: b.q, secs: b.secs, d: b.d, a: b.a, tags: b.tags, shot: b.shot, sc: b.sc, ...(b.ms ? { ms: b.ms } : {}), ...(b.fire ? { fire: b.fire } : {}), ...(b.run ? { run: b.run } : {}) })),
    splits: { home: split(l => l.home), away: split(l => !l.home), wins: split(l => l.wl === 'W'), losses: split(l => l.wl === 'L'), months: months.map(m => ({ m, ...split(l => l.date.startsWith(m)) })) },
    games30: lines.filter(l => l.P >= 30).length, logsPartial,
    splitsLabel: retired ? (lines.length ? `Career · ${logsPartial ? 'games since ' + FIRST_LOG_SEASON : 'every game'}` : null) : null,
  };
  profile.badges = badges(profile);
  return profile;
}
function teamSpans(seasons) {
  const out = [];
  seasons.forEach(s => s.team.split('/').forEach(t => { const y = +s.season.slice(0, 4); const last = out.find(o => o.team === t && o.to >= y - 1); if (last) last.to = y; else out.push({ team: t, from: y, to: y }); }));
  return out.map(o => ({ ...o, team: TEAM_NAMES[o.team] || o.team }));
}

main().catch(e => { console.error(e); process.exit(1); });
