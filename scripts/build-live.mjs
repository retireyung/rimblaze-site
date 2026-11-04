#!/usr/bin/env node
// RimBlaze live snapshot.
//
// NBA.com won't let other websites read its live files from visitors' browsers, so the site
// can't load them directly. This script fetches them on a home connection instead and writes
// same-site copies the homepage reads:
//   data/live/<YYYY-MM-DD>.json  one game night: game scores, rare buckets and box score lines
//   data/live/index.json         which nights exist and which one to show first
//
// Finished games are cached in data/cache/live and never fetched again; games in progress
// are refreshed every run. A night's file is rewritten only when something in it changed.
//
// Usage: node scripts/build-live.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdn } from './nba.mjs';
import { rareBuckets, quarterPoints, RULES_VERSION } from './feats.mjs';
import { careerFromCompact } from './career.mjs';
import { renderNights } from './nights.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Finished games are cached per rules version, so a rule change recomputes them once.
const DATA = path.join(ROOT, 'data'), LIVE = path.join(DATA, 'live'), CACHE = path.join(DATA, 'cache', `live-v${RULES_VERSION}`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJSON = async (f, d = null) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } };
const writeJSON = async (f, v) => { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(v)); };
async function writeData(f, v) {
  const old = await readJSON(f), strip = o => JSON.stringify({ ...o, updated: null });
  if (old && strip(old) === strip(v)) return false;
  await writeJSON(f, v); return true;
}
const etDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function boxLines(box) {
  const G = box.game, out = [];
  for (const [mine, theirs] of [['homeTeam', 'awayTeam'], ['awayTeam', 'homeTeam']]) {
    const T = G[mine], O = G[theirs];
    for (const pl of T.players || []) {
      const s = pl.statistics || {};
      if (pl.played !== '1') continue;
      out.push({ n: pl.name, pid: pl.personId, t: T.teamTricode, o: O.teamTricode, gameId: G.gameId, live: G.gameStatus === 2,
        P: +s.points || 0, R: +s.reboundsTotal || 0, A: +s.assists || 0, S: +s.steals || 0, B: +s.blocks || 0,
        tpm: +s.threePointersMade || 0, fgm: +s.fieldGoalsMade || 0, fga: +s.fieldGoalsAttempted || 0 });
    }
  }
  return out;
}

async function game(g, names, career) {
  const cacheFile = path.join(CACHE, g.gameId + '.json');
  const hit = await readJSON(cacheFile);
  if (hit) return hit;
  const box = await cdn(`liveData/boxscore/boxscore_${g.gameId}.json`);
  if (!box?.game) return null;
  const G = box.game;
  let buckets = [], quarters = {};
  if (G.gameStatus >= 2) {
    const pbp = await cdn(`liveData/playbyplay/playbyplay_${g.gameId}.json`);
    const acts = pbp?.game?.actions || [], GG = { ...g, final: G.gameStatus === 3 };
    buckets = rareBuckets(acts, GG, { careerBefore: pid => career.before(pid, g.gameId, g.date) })
      .map(b => ({ ...b, n: names.get(b.pid) || b.n, k: g.arenaName || '' }));
    quarters = quarterPoints(acts, GG);
  }
  const out = {
    game: { id: G.gameId, status: G.gameStatus, text: (G.gameStatusText || '').trim(),
      away: G.awayTeam.teamTricode, home: G.homeTeam.teamTricode, awayScore: G.awayTeam.score, homeScore: G.homeTeam.score },
    buckets, lines: G.gameStatus >= 2 ? boxLines(box).map(l => quarters[l.pid] ? { ...l, qMax: quarters[l.pid].qMax, qPer: quarters[l.pid].period } : l) : [],
  };
  if (G.gameStatus === 3) await writeJSON(cacheFile, out); // finished games never change
  return out;
}

async function main() {
  let sched = null;
  for (const f of ['staticData/scheduleLeagueV2_1.json', 'staticData/scheduleLeagueV2.json']) {
    try { sched = await cdn(f); if (sched?.leagueSchedule) break; } catch (e) { log(`schedule ${f}: ${e.message.split(' failed: ').pop()}`); }
  }
  if (!sched?.leagueSchedule) throw new Error('NBA.com schedule unavailable');
  const today = etDate();
  let live = new Map();
  try {
    const sb = await cdn('liveData/scoreboard/todaysScoreboard_00.json');
    live = new Map((sb?.scoreboard?.games || []).map(g => [g.gameId, g.gameStatus]));
  } catch (e) { log(`scoreboard: ${e.message}`); }
  const playerList = (await readJSON(path.join(DATA, 'players.json'), [])) || [];
  const names = new Map(playerList.map(p => [p.id, p.name]));
  // career totals for MILESTONE (written by the stats build); without them, milestones just wait for it
  const career = careerFromCompact(await readJSON(path.join(DATA, 'cache', 'career-base.json'), null));

  const byDate = new Map();
  for (const gd of sched.leagueSchedule.gameDates || []) {
    const m = /(\d+)\/(\d+)\/(\d+)/.exec(gd.gameDate); if (!m) continue;
    const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const games = (gd.games || []).filter(g => /^00[2456]/.test(g.gameId)); // regular season, play-in, playoffs, Cup final
    if (games.length && iso <= today) byDate.set(iso, games);
  }

  const dates = [], days = [];
  let changed = 0, latest = null;
  for (const [date, games] of [...byDate.entries()].sort()) {
    const started = games.filter(g => date < today || (live.get(g.gameId) ?? g.gameStatus) >= 2);
    if (!started.length) continue;
    const results = [];
    for (const g of started) {
      try { const r = await game({ ...g, date }, names, career); if (r && r.game.status >= 2) results.push(r); } catch (e) { log(`game ${g.gameId}: ${e.message}`); }
    }
    if (!results.length) continue;
    const day = {
      date, updated: new Date().toISOString(),
      anyLive: results.some(r => r.game.status === 2),
      games: results.map(r => r.game),
      buckets: results.flatMap(r => r.buckets),
      lines: results.flatMap(r => r.lines),
    };
    if (await writeData(path.join(LIVE, date + '.json'), day)) changed++;
    days.push(day);
    dates.push(date); latest = date;
  }
  await writeData(path.join(LIVE, 'index.json'), { updated: new Date().toISOString(), latest, dates });
  const pages = await renderNights({ root: ROOT, days, players: playerList });
  log(`live: ${dates.length} game nights, ${changed} updated, latest ${latest} · ${pages} night pages written`);
}

main().catch(e => { console.error(e); process.exit(1); });
