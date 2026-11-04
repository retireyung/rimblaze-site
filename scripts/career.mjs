// Career regular-season totals (points, threes) a player had before a given game, for MILESTONE.
//
// Built from NBA.com game logs, which start in 1996-97. For a player whose career began earlier,
// the points he scored before 1996-97 come from his profile's career totals (career minus logged).
// If that isn't known (an older player without a profile), his milestones are skipped rather than
// guessed.

// lines: [{pid, date, gameId, P, tpm, season}], careers: Map(pid -> {pts, tpm, from}) (optional)
export function careerIndex(lines, careers = new Map(), firstLogSeason = '1996-97') {
  const by = new Map();
  for (const l of lines) { if (!by.has(l.pid)) by.set(l.pid, []); by.get(l.pid).push(l); }
  const idx = new Map();
  for (const [pid, ls] of by) {
    ls.sort((a, b) => a.date.localeCompare(b.date) || String(a.gameId).localeCompare(String(b.gameId)));
    const sumP = ls.reduce((s, l) => s + (l.P || 0), 0), sumT = ls.reduce((s, l) => s + (l.tpm || 0), 0);
    const c = careers.get(pid);
    let offP = 0, offT = 0;
    if (ls[0].season === firstLogSeason) { // may have played before the logs begin
      if (!c || c.from == null) { idx.set(pid, null); continue; }
      if (+c.from < +firstLogSeason.slice(0, 4)) { offP = Math.max(0, c.pts - sumP); offT = Math.max(0, c.tpm - sumT); }
    }
    // prefix sums: totals before game k
    const dates = [], ids = [], P = [], T = [];
    let p = offP, t = offT;
    for (const l of ls) { dates.push(l.date); ids.push(String(l.gameId)); P.push(p); T.push(t); p += l.P || 0; t += l.tpm || 0; }
    idx.set(pid, { dates, ids, P, T, totalP: p, totalT: t });
  }
  return {
    // totals before the game with this id (or, if it isn't logged yet, before this date)
    before(pid, gameId, date) {
      const e = idx.get(pid); if (e === null) return null; if (!e) return { pts: 0, tpm: 0 }; // first career game
      const k = e.ids.indexOf(String(gameId));
      if (k >= 0) return { pts: e.P[k], tpm: e.T[k] };
      let j = 0; while (j < e.dates.length && e.dates[j] < date) j++;
      return j < e.dates.length ? { pts: e.P[j], tpm: e.T[j] } : { pts: e.totalP, tpm: e.totalT };
    },
    // compact form for the live build: totals through the logs, plus this season's games
    compact(pids, season) {
      const out = {};
      for (const pid of pids) {
        const e = idx.get(pid); if (!e) continue;
        const games = [];
        e.dates.forEach((d, k) => { if (k >= 0) games.push([e.ids[k], d, e.P[k], e.T[k]]); });
        out[pid] = { total: [e.totalP, e.totalT], recent: games.slice(-12) };
      }
      return out;
    },
  };
}

// The live build's side: read the compact form back.
export function careerFromCompact(compact) {
  return {
    before(pid, gameId, date) {
      const e = compact?.[pid]; if (!e) return null;
      const hit = e.recent.find(g => g[0] === String(gameId)) || e.recent.find(g => g[1] >= date);
      return hit ? { pts: hit[2], tpm: hit[3] } : { pts: e.total[0], tpm: e.total[1] };
    },
  };
}
