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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stats, cdn, rows, seasonFor, seasonList, wikidataBios } from './nba.mjs';
import { feats, featScore, tens, rareBuckets, isRare, WATCH_MIN, MILESTONES, nextMilestone, badges } from './feats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data'), CACHE = path.join(DATA, 'cache');
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const SEASON = arg('season') || seasonFor();
const ONLY = (arg('players') || '').split(',').filter(Boolean).map(Number);
const FIRST_LOG_SEASON = '1996-97'; // NBA.com game logs are complete from here on
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
async function seasonBuckets() {
  let sched = null;
  for (const f of ['staticData/scheduleLeagueV2_1.json', 'staticData/scheduleLeagueV2.json']) {
    try { sched = await cdn(f); if (sched?.leagueSchedule) break; } catch (e) { log(`schedule ${f}: ${e.message.split(' failed: ').pop()}`); }
  }
  if (!sched?.leagueSchedule) throw new Error('NBA.com schedule unavailable');
  const games = (sched?.leagueSchedule?.gameDates || []).flatMap(gd => (gd.games || []).map(g => ({ ...g, date: gd.gameDate })))
    .filter(g => /^002/.test(g.gameId) && g.gameStatus === 3);
  const out = [];
  let missed = 0;
  for (const g of games) {
    const m = /(\d+)\/(\d+)\/(\d+)/.exec(g.date), date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    try {
      // Only a successful download is cached, so a game that failed tonight is retried tomorrow.
      const list = await cached(`buckets/${g.gameId}.json`, Infinity, async () => {
        const pbp = await cdn(`liveData/playbyplay/playbyplay_${g.gameId}.json`);
        if (!pbp) throw new Error('no play-by-play yet');
        return rareBuckets(pbp.game.actions || [], g);
      });
      list.filter(b => isRare(b.tags)).forEach(b => out.push({ ...b, date })); // re-check cached games against today's rules
    } catch (e) { missed++; }
  }
  log(`rare buckets: ${out.length} from ${games.length - missed} of ${games.length} final games`);
  return out;
}

// ---------- 3. Helpers over game lines ----------
function seasonFeatTotals(lines) {
  const P = new Map();
  const byPlayer = new Map();
  lines.forEach(l => { if (!byPlayer.has(l.pid)) byPlayer.set(l.pid, []); byPlayer.get(l.pid).push(l); });
  for (const [pid, ls] of byPlayer) {
    ls.sort((a, b) => a.date.localeCompare(b.date));
    let run = 0, best = 0;
    const r = { pid, name: ls[0].n, team: ls[ls.length - 1].t, gp: ls.length, td: 0, dd: 0, p30: 0, p40: 0, streak: 0, bestStreak: 0 };
    ls.forEach(l => {
      const t = tens(l);
      if (t >= 3) r.td++; if (t >= 2) { r.dd++; run++; best = Math.max(best, run); } else run = 0;
      if (l.P >= 30) r.p30++; if (l.P >= 40) r.p40++;
    });
    r.streak = run; r.bestStreak = best; P.set(pid, r);
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
  const linesBy = new Map();
  allLines.forEach(l => { if (!linesBy.has(l.pid)) linesBy.set(l.pid, []); linesBy.get(l.pid).push(l); });

  // season feat records since 1996-97 (for the chases)
  const records = { td: null, p40: null, ddStreak: null };
  for (const s of seasons.filter(x => x !== SEASON)) {
    const T = seasonFeatTotals(allLines.filter(l => l.season === s));
    for (const r of T.values()) {
      if (!records.td || r.td > records.td.v) records.td = { v: r.td, name: r.name, season: s };
      if (!records.p40 || r.p40 > records.p40.v) records.p40 = { v: r.p40, name: r.name, season: s };
      if (!records.ddStreak || r.bestStreak > records.ddStreak.v) records.ddStreak = { v: r.bestStreak, name: r.name, season: s };
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

  // hometown, high school and college from Wikidata (weekly; a failure just leaves those fields empty)
  let bios = new Map();
  try {
    const raw = await cached('wikidata-bios.json', 7 * DAY, async () => [...(await wikidataBios(active.map(p => p.id))).entries()]);
    bios = new Map(raw);
    log(`wikidata bios: ${bios.size} players`);
  } catch (e) { log(`wikidata bios unavailable: ${e.message}`); }

  // rare buckets
  const fullName = new Map(active.map(p => [p.id, p.name]));
  cur.forEach(l => { if (!fullName.has(l.pid)) fullName.set(l.pid, l.n); });
  let rawBuckets = [];
  try { rawBuckets = await seasonBuckets(); } catch (e) { log(`rare buckets skipped tonight: ${e.message}`); }
  const buckets = rawBuckets.map(b => ({ ...b, n: fullName.get(b.pid) || b.n }));
  await writeJSON(path.join(DATA, 'buckets', SEASON + '.json'), buckets);

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
  const targets = ONLY.length ? active.filter(p => ONLY.includes(p.id)) : active;
  const profiles = [];
  let i = 0;
  for (const a of targets) {
    i++; if (i % 50 === 0) log(`players ${i}/${targets.length}`);
    try {
      const career = await careerFresh(a.id, () => stats('playercareerstats', { PlayerID: a.id, PerMode: 'Totals', LeagueID: '00' }));
      const info = await cached(`info/${a.id}.json`, 7 * DAY, () => stats('commonplayerinfo', { PlayerID: a.id, LeagueID: '00' }));
      const awardsRaw = await cached(`awards/${a.id}.json`, 7 * DAY, () => stats('playerawards', { PlayerID: a.id }));
      profiles.push(buildProfile(a, career, info, awardsRaw, linesBy.get(a.id) || [], buckets.filter(b => b.pid === a.id), rank, bios.get(a.id)));
    } catch (e) { log(`skip ${a.name}: ${e.message}`); }
  }

  for (const p of profiles) await writeJSON(path.join(DATA, 'players', p.person.id + '.json'), p);
  await writeJSON(path.join(DATA, 'players.json'), profiles.map(p => ({ id: p.person.id, name: p.person.name, team: p.person.team?.abbr || '', slug: slugify(p.person.name) + '-' + p.person.id })));

  // season.json
  const T = seasonFeatTotals(cur);
  const teamGames = Math.max(0, ...[...new Set(cur.map(l => l.t))].map(t => new Set(cur.filter(l => l.t === t).map(l => l.gameId)).size));
  const leaders = [...T.values()].filter(r => r.td || r.dd || r.p30).sort((a, b) => b.td - a.td || b.p40 - a.p40 || b.dd - a.dd || b.p30 - a.p30).slice(0, 15);
  const topTd = [...T.values()].sort((a, b) => b.td - a.td)[0], topStreak = [...T.values()].sort((a, b) => b.streak - a.streak)[0], top40 = [...T.values()].sort((a, b) => b.p40 - a.p40)[0];
  const chase = [];
  const vs = (cur, rec) => cur > rec.v ? { max: cur, lbl: `${cur} · past the mark of ${rec.v}` } : { max: rec.v, lbl: `${cur} of ${rec.v}` };
  if (topTd?.td && records.td?.v) chase.push({ pid: topTd.pid, name: topTd.name, what: `Triple-doubles this season. Most in a season since ${FIRST_LOG_SEASON}: ${records.td.v} by ${records.td.name} (${records.td.season}).`, cur: topTd.td, ...vs(topTd.td, records.td), need: 'Pace: ' + pace(topTd.td, topTd.gp, teamGames) });
  if (topStreak?.streak && records.ddStreak?.v) chase.push({ pid: topStreak.pid, name: topStreak.name, what: `Active double-double streak. Longest in one season since ${FIRST_LOG_SEASON}: ${records.ddStreak.v} by ${records.ddStreak.name} (${records.ddStreak.season}).`, cur: topStreak.streak, max: Math.max(topStreak.streak, records.ddStreak.v), need: topStreak.streak > records.ddStreak.v ? 'New mark' : (records.ddStreak.v - topStreak.streak) + ' to tie', lbl: topStreak.streak + ' straight' });
  if (top40?.p40 && records.p40?.v) chase.push({ pid: top40.pid, name: top40.name, what: `40-point games this season. Most in a season since ${FIRST_LOG_SEASON}: ${records.p40.v} by ${records.p40.name} (${records.p40.season}).`, cur: top40.p40, ...vs(top40.p40, records.p40), need: 'Pace: ' + pace(top40.p40, top40.gp, teamGames) });
  const rareBy = new Map();
  buckets.forEach(b => {
    const r = rareBy.get(b.pid) || { pid: b.pid, name: b.n, team: b.t, rare: 0, logo: 0, buzz: 0, go: 0, deep: 0 };
    r.rare++; if (b.tags.includes('LOGO') || b.tags.includes('HEAVE')) r.logo++; if (b.tags.includes('BUZZER')) r.buzz++; if (b.tags.includes('GO-AHEAD')) r.go++; r.deep = Math.max(r.deep, b.d || 0);
    rareBy.set(b.pid, r);
  });
  const teamRare = Object.entries(buckets.reduce((m, b) => (m[b.t] = (m[b.t] || 0) + 1, m), {})).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  await writeData(path.join(DATA, 'season.json'), {
    season: SEASON, updated: new Date().toISOString(), since: FIRST_LOG_SEASON,
    leaders: leaders.map(r => ({ pid: r.pid, name: r.name, team: r.team, td: r.td, dd: r.dd, p30: r.p30, p40: r.p40, streak: r.streak })),
    chase,
    rareLeaders: [...rareBy.values()].sort((a, b) => b.rare - a.rare || b.deep - a.deep).slice(0, 10),
    teamRare,
  });

  // career.json
  const watch = [];
  for (const p of profiles) {
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
    const inn = profiles.filter(p => (p.career[k] || 0) >= v);
    const next = profiles.filter(p => (p.career[k] || 0) < v).sort((a, b) => (b.career[k] || 0) - (a.career[k] || 0))[0];
    return { club: v.toLocaleString() + ' ' + MILESTONES[k].label, n: inn.length, members: inn.map(p => p.person.name), next: next ? next.person.name : '—', nextPid: next?.person.id, nextNeed: next ? v - (next.career[k] || 0) : null };
  });
  await writeData(path.join(DATA, 'career.json'), { updated: new Date().toISOString(), watch: watch.slice(0, 12), clubs });

  if (!process.argv.includes('--skip-pages')) await renderPages(profiles);
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
    .map(l => ({ date: l.date, season: l.season, gameId: l.gameId, opp: l.opp, home: l.home, wl: l.wl, P: l.P, R: l.R, A: l.A, S: l.S, B: l.B, tpm: l.tpm, fgm: l.fgm, fga: l.fga, feats: l.feats, score: featScore(l.feats) }));
  const highs = [['P', 'Points'], ['R', 'Rebounds'], ['A', 'Assists'], ['tpm', 'Threes'], ['S', 'Steals'], ['B', 'Blocks']].map(([k, label]) => {
    const best = lines.slice().sort((x, y) => y[k] - x[k] || x.date.localeCompare(y.date))[0];
    return best ? { stat: label, v: best[k], date: best.date, opp: best.opp, home: best.home, gameId: best.gameId, line: { P: best.P, R: best.R, A: best.A } } : null;
  }).filter(Boolean);
  const curLines = lines.filter(l => l.season === SEASON);
  const split = f => { const ls = curLines.filter(f); return { gp: ls.length, ppg: ls.length ? +(ls.reduce((s, l) => s + l.P, 0) / ls.length).toFixed(1) : null, rpg: ls.length ? +(ls.reduce((s, l) => s + l.R, 0) / ls.length).toFixed(1) : null, apg: ls.length ? +(ls.reduce((s, l) => s + l.A, 0) / ls.length).toFixed(1) : null }; };
  const months = [...new Set(curLines.map(l => l.date.slice(0, 7)))];
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
      team: { abbr: info.TEAM_ABBREVIATION || a.team, name: `${info.TEAM_CITY || ''} ${info.TEAM_NAME || ''}`.trim() || a.teamName },
      teams: teamSpans(seasons), active: true,
    },
    seasons, career, awards, highs, nights: nights.sort((x, y) => y.date.localeCompare(x.date)), ddDates,
    buckets: buckets.map(b => ({ date: b.date, gameId: b.gameId, o: b.o, q: b.q, secs: b.secs, d: b.d, a: b.a, tags: b.tags, shot: b.shot, sc: b.sc })),
    splits: { home: split(l => l.home), away: split(l => !l.home), wins: split(l => l.wl === 'W'), losses: split(l => l.wl === 'L'), months: months.map(m => ({ m, ...split(l => l.date.startsWith(m)) })) },
    games30: lines.filter(l => l.P >= 30).length,
  };
  profile.badges = badges(profile);
  return profile;
}
function teamSpans(seasons) {
  const out = [];
  seasons.forEach(s => s.team.split('/').forEach(t => { const y = +s.season.slice(0, 4); const last = out.find(o => o.team === t && o.to >= y - 1); if (last) last.to = y; else out.push({ team: t, from: y, to: y }); }));
  return out;
}

// ---------- pre-rendered pages ----------
async function renderPages(profiles) {
  const tplFile = path.join(ROOT, 'player.html');
  if (!existsSync(tplFile)) { log('player.html not found, skipping pages'); return; }
  const tpl = await readFile(tplFile, 'utf8');
  for (const p of profiles) {
    const n = p.person.name, c = p.career, desc = `${n} has ${c.pts.toLocaleString()} career points, ${c.td} triple-doubles and ${p.badges.length} RimBlaze badges. Every season, big night, rare bucket and milestone.`;
    const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const html = tpl
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(n)} Stats, Big Nights &amp; Milestones | RimBlaze</title>`)
      .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`)
      .replace(/<script type="application\/json" id="rb-sample">[\s\S]*?<\/script>/, '')
      .replace('<!--RB-DATA-->', `<base href="/"><link rel="canonical" href="https://rimblaze.com/players/${slugify(n)}-${p.person.id}/"><meta name="rb-prod" content="1"><script type="application/json" id="rb-data">${JSON.stringify(p).replace(/</g, '\\u003c')}</script>`);
    await mkdir(path.join(ROOT, 'players', slugify(n) + '-' + p.person.id), { recursive: true });
    await writeFile(path.join(ROOT, 'players', slugify(n) + '-' + p.person.id, 'index.html'), html);
  }
  log(`pages: ${profiles.length}`);
  const today = new Date().toISOString().slice(0, 10);
  const urls = ['https://rimblaze.com/', ...profiles.map(p => `https://rimblaze.com/players/${slugify(p.person.name)}-${p.person.id}/`)];
  await writeFile(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
