#!/usr/bin/env node
// One-time backfill: rare buckets for past seasons, so "Since tracking began" covers 1996-97 on.
//
// For every regular-season game of each past season it downloads the play-by-play, applies the
// same rules as tonight's games (scripts/feats.mjs → rareBuckets) and writes
//   data/buckets/<season>.json   every rare bucket of that season
// The stats build then totals all of these files into the "Since tracking began" leaders.
//
// Run it on the home PC (NBA.com answers home connections, not cloud servers):
//   node scripts/backfill-buckets.mjs --dry --season 2024-25 --limit 5   # quick check, writes nothing
//   node scripts/backfill-buckets.mjs                                    # everything, newest season first
//   node scripts/backfill-buckets.mjs --from 2015-16 --to 2024-25        # a range
//
// It is safe to stop (Ctrl+C) and run again: each game's result is cached in data/cache/hist/,
// and a season's file is only written once every game of that season is done, so a half-finished
// season never shows up on the site. At the default pace (one request every 0.7 s) the full run
// takes roughly 8-14 hours; RB_GAP_MS=1200 slows it down if NBA.com starts throttling.
//
// Older play-by-play is less detailed than today's:
//   - game clocks before about 2019 often have whole seconds only, so a shot at "0:01" may have
//     come with up to 1.9 s left; on those games BUZZER counts only shots at 0:00 (no overcounting)
//   - shot distances are missing on some of the earliest seasons; those shots can't be LOGO/HEAVE

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stats, cdn, rows, seasonFor, seasonList } from './nba.mjs';
import { rareBuckets, isRare } from './feats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data'), CACHE = path.join(DATA, 'cache'), HIST = path.join(CACHE, 'hist');
const FIRST = '1996-97';
const log = (...a) => console.log(new Date().toLocaleTimeString('en-US', { hour12: false }), ...a);
const readJSON = async (f, d = null) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } };
async function writeJSON(f, v) { // write to a temp file first so a stopped run never leaves half a file
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + '.tmp', JSON.stringify(v)); await rename(f + '.tmp', f);
}

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes('--dry'), LIMIT = +(opt('limit') || 0) || Infinity;
const CURRENT = seasonFor();
const prevSeason = s => { const y = +s.slice(0, 4) - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };
let seasons = opt('season') ? [opt('season')] : seasonList(opt('from') || FIRST, opt('to') || prevSeason(CURRENT));
seasons = seasons.filter(s => s < CURRENT).reverse(); // newest first: the most recognizable buckets land soonest

// ---- games of a season: from the stats build's cached game logs, or NBA.com's team game log ----
async function seasonGames(season) {
  const byId = new Map();
  const cachedLog = await readJSON(path.join(CACHE, `gamelog-${season}.json`));
  if (cachedLog?.v?.length) {
    // compact rows: [pid, name, team, date, gameId, opp, home, ...]
    for (const [, , t, date, gameId, opp, home] of cachedLog.v) {
      if (!/^002/.test(gameId) || byId.has(gameId)) continue;
      byId.set(gameId, { gameId, date, home: home ? t : opp, away: home ? opp : t });
    }
  } else {
    const list = rows(await stats('leaguegamelog', { Counter: 0, Direction: 'ASC', LeagueID: '00', PlayerOrTeam: 'T', Season: season, SeasonType: 'Regular Season', Sorter: 'DATE' }));
    for (const r of list) {
      const id = r.GAME_ID; if (!/^002/.test(id)) continue;
      const g = byId.get(id) || { gameId: id, date: String(r.GAME_DATE).slice(0, 10) };
      if (/vs\./.test(r.MATCHUP)) g.home = r.TEAM_ABBREVIATION; else g.away = r.TEAM_ABBREVIATION;
      byId.set(id, g);
    }
  }
  return [...byId.values()].filter(g => g.home && g.away).sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId));
}

// ---- play-by-play: cdn.nba.com (same format as live games) or stats.nba.com playbyplayv3 ----
const lower = s => String(s || '').toLowerCase();
function fromV3(actions) {
  // playbyplayv3 → the cdn live format rareBuckets() reads
  return actions.map(a => {
    const t = lower(a.actionType), made = lower(a.shotResult) === 'made' || t === 'made shot';
    const isShot = t === 'made shot' || t === 'missed shot';
    const val = +a.shotValue || (/3pt/i.test(a.description || '') ? 3 : 2);
    return {
      actionNumber: a.actionNumber, period: +a.period, clock: a.clock, personId: a.personId,
      playerName: a.playerName, playerNameI: a.playerNameI, teamTricode: a.teamTricode,
      actionType: isShot ? (val === 3 ? '3pt' : '2pt') : (t === 'free throw' ? 'freethrow' : t),
      subType: a.subType, shotResult: isShot ? (made ? 'Made' : 'Missed') : a.shotResult,
      shotDistance: a.shotDistance === '' || a.shotDistance == null ? null : +a.shotDistance,
      xLegacy: a.xLegacy, yLegacy: a.yLegacy, scoreHome: a.scoreHome, scoreAway: a.scoreAway, timeActual: '',
    };
  });
}
// Whole-second clocks: if no shot in a game's last minutes shows tenths, the clock is coarse.
function coarseClock(actions) {
  const late = actions.filter(a => /^PT00M/.test(a.clock || ''));
  return late.length > 0 && !late.some(a => /\.\d*[1-9]/.test(a.clock));
}

async function playByPlay(gameId) {
  try {
    const live = await cdn(`liveData/playbyplay/playbyplay_${gameId}.json`);
    if (live?.game?.actions?.length) return { actions: live.game.actions, src: 'cdn' };
  } catch {}
  const v3 = await stats('playbyplayv3', { GameID: gameId, StartPeriod: 0, EndPeriod: 0 });
  const acts = v3?.game?.actions;
  if (!acts?.length) return null;
  return { actions: fromV3(acts), src: 'v3' };
}

async function gameBuckets(g) {
  const cacheFile = path.join(HIST, g.gameId + '.json');
  const hit = DRY ? null : await readJSON(cacheFile);
  if (hit) return hit;
  const pbp = await playByPlay(g.gameId);
  if (!pbp) { const e = new Error('no play-by-play on record'); e.permanent = true; throw e; }
  const coarse = coarseClock(pbp.actions);
  let list = rareBuckets(pbp.actions, { gameId: g.gameId, homeTeam: { teamTricode: g.home }, awayTeam: { teamTricode: g.away } });
  if (coarse) list = list.map(b => (b.tags.includes('BUZZER') && b.secs > 0 ? { ...b, tags: b.tags.filter(x => x !== 'BUZZER') } : b)).filter(b => isRare(b.tags));
  const out = { src: pbp.src, coarse, buckets: list.map(b => ({ ...b, date: g.date })) };
  if (!DRY) await writeJSON(cacheFile, out);
  return out;
}

async function main() {
  log(`backfill: ${seasons.length} season(s) ${seasons.at(-1)} to ${seasons[0]}${DRY ? ' · DRY RUN (nothing written)' : ''}`);
  let grand = 0;
  for (const season of seasons) {
    const outFile = path.join(DATA, 'buckets', season + '.json');
    if (!DRY && !opt('season') && (await readJSON(outFile))) { log(`${season}: already done`); continue; }
    const games = (await seasonGames(season)).slice(0, LIMIT);
    if (!games.length) { log(`${season}: no games found, skipped`); continue; }
    const all = []; let failed = 0, missing = 0, done = 0, coarse = 0; const srcs = {};
    for (const g of games) {
      try {
        const r = await gameBuckets(g);
        all.push(...r.buckets); srcs[r.src] = (srcs[r.src] || 0) + 1; if (r.coarse) coarse++;
        if (DRY) r.buckets.forEach(b => log(`  ${g.date} ${b.n} (${b.t}) ${b.tags.join('+')} ${b.d ?? '?'} ft, ${b.secs ?? '?'} s left · ${b.sc}`));
      } catch (e) {
        if (e.permanent) missing++; else failed++;
        if (failed + missing <= 3) log(`  ${g.gameId}: ${e.message.split(' failed: ').pop()}`);
      }
      if (++done % 100 === 0) log(`${season}: ${done}/${games.length} games, ${all.length} rare buckets so far`);
    }
    log(`${season}: ${all.length} rare buckets from ${games.length - failed - missing}/${games.length} games` +
      (missing ? `, ${missing} with no play-by-play on record` : '') +
      ` (sources ${JSON.stringify(srcs)}, whole-second clocks in ${coarse})`);
    grand += all.length;
    if (DRY) continue;
    if (failed) { log(`${season}: ${failed} game(s) failed, so the season file is not written yet. Run again to retry them.`); continue; }
    all.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    await writeJSON(outFile, all);
  }
  log(`backfill finished: ${grand} rare buckets.${DRY ? '' : ' The next stats build adds them to "Since tracking began".'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
