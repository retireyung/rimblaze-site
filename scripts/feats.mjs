// Shared RimBlaze rules: what counts as a big night, a rare bucket, a badge and a milestone.
// The site pages use the same thresholds, so keep the two in step.

export const FEAT_WEIGHT = {
  'QUADRUPLE-DOUBLE': 100, '60-POINT GAME': 95, '5x5': 85, '50-POINT GAME': 75,
  'TRIPLE-DOUBLE': 60, '20-20': 55, '10+ THREES': 50, '40-POINT GAME': 45,
  '15+ ASSISTS': 40, '20+ REBOUNDS': 40, '5+ STEALS': 32, '5+ BLOCKS': 32,
  'PERFECT FROM THE FIELD': 28, '20-POINT QUARTER': 52,
};

// Bump this when the rules change: cached results computed under an older version are recomputed.
export const RULES_VERSION = 2;

// p = {P,R,A,S,B,tpm,fgm,fga, qMax?} (qMax: his most points in one quarter or overtime, from play-by-play)
export function tens(p) { return [p.P, p.R, p.A, p.S, p.B].filter(v => v >= 10).length; }

export function feats(p) {
  const t = tens(p), f = [];
  if (t >= 4) f.push('QUADRUPLE-DOUBLE'); else if (t === 3) f.push('TRIPLE-DOUBLE');
  if (p.P >= 60) f.push('60-POINT GAME'); else if (p.P >= 50) f.push('50-POINT GAME'); else if (p.P >= 40) f.push('40-POINT GAME');
  if (p.P >= 20 && p.R >= 20) f.push('20-20');
  if ([p.P, p.R, p.A, p.S, p.B].every(v => v >= 5)) f.push('5x5');
  if (p.A >= 15) f.push('15+ ASSISTS');
  if (p.R >= 20) f.push('20+ REBOUNDS');
  if (p.S >= 5) f.push('5+ STEALS');
  if (p.B >= 5) f.push('5+ BLOCKS');
  if (p.tpm >= 10) f.push('10+ THREES');
  if (p.fga >= 8 && p.fgm === p.fga) f.push('PERFECT FROM THE FIELD');
  if (p.qMax >= 20) f.push('20-POINT QUARTER');
  return f;
}
export const featScore = f => f.reduce((s, k) => s + (FEAT_WEIGHT[k] || 0), 0);

// ---- Rare buckets from NBA.com live play-by-play ----
export function parseClock(c) { const m = /PT(\d+)M([\d.]+)S/.exec(c || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }
export function period(p) { return p <= 4 ? 'Q' + p : (p === 5 ? 'OT' : 'OT' + (p - 4)); }

// A plain and-one happens about four times a game, so it only counts when it's also clutch.
export const isRare = tags => tags.length > 0 && !(tags.length === 1 && tags[0] === 'AND-ONE');

// Milestone watch only shows numbers worth celebrating (the profile ladder still shows every rung).
export const WATCH_MIN = { pts: 10000, reb: 5000, ast: 5000, tpm: 1000, stl: 1000, blk: 1000, td: 25 };

// Shot distance is measured from the hoop. The half-court line is about 42 ft from the hoop
// (47 ft from the baseline), so 43+ ft means the shot came from the other half of the court.
export const DIST = { logo: 30, heave: 40, halfCourt: 43 };
// Streak thresholds, set from real games so each lands about once a night league-wide.
export const STREAK = { fire: 5, takeover: 12 };
export const MS_STEPS = { pts: v => v >= 10000 && v % 5000 === 0, tpm: v => v >= 1000 && v % 1000 === 0 };
const nth = v => v.toLocaleString('en-US') + 'th';

// Points scored on each action, from the running score (works for live and archived play-by-play).
function* scoring(actions, home, away) {
  let h = 0, w = 0;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const sh = a.scoreHome === '' || a.scoreHome == null ? null : +a.scoreHome, sa = a.scoreAway === '' || a.scoreAway == null ? null : +a.scoreAway;
    if (sh == null || sa == null || isNaN(sh) || isNaN(sa)) { yield { i, a, pts: 0 }; continue; }
    const dh = sh - h, dw = sa - w; h = sh; w = sa;
    // One play scores at most 4 (a four-point play); anything else is a gap in the record, so just resync.
    if (dh < 0 || dw < 0 || dh > 4 || dw > 4 || (dh > 0 && dw > 0)) { yield { i, a, pts: 0, h, w }; continue; }
    const team = dh > 0 ? home : dw > 0 ? away : null, pts = Math.max(dh, dw, 0);
    yield { i, a, pts: team && a.teamTricode === team ? pts : 0, team, h, w };
  }
}

// Most points each player scored in a single period: { pid: { qMax, period } }.
export function quarterPoints(actions, game) {
  const per = new Map();
  for (const { a, pts } of scoring(actions, game.homeTeam.teamTricode, game.awayTeam.teamTricode)) {
    if (!pts || !a.personId) continue;
    const k = a.personId + '|' + a.period; per.set(k, (per.get(k) || 0) + pts);
  }
  const out = {};
  for (const [k, v] of per) { const [pid, q] = k.split('|'); if (!out[pid] || v > out[pid].qMax) out[pid] = { qMax: v, period: +q }; }
  return out;
}

// game: { gameId, homeTeam:{teamTricode}, awayTeam:{teamTricode}, final?: bool }
// ctx:  { careerBefore?: pid => ({pts, tpm} career regular-season totals before this game) | null, coarse?: bool }
export function rareBuckets(actions, game, ctx = {}) {
  const home = game.homeTeam.teamTricode, away = game.awayTeam.teamTricode, out = [];
  const regular = /^002/.test(game.gameId || '');
  const steps = [...scoring(actions, home, away)];
  const fire = new Map(), run = new Map(), gamePts = new Map(), gameThrees = new Map();
  // GAME-WINNER: the lead must hold through the end of the game.
  const holds = (from, team) => {
    for (let j = from + 1; j < steps.length; j++) {
      const s = steps[j]; if (s.h == null) continue;
      const us = team === home ? s.h : s.w, them = team === home ? s.w : s.h;
      if (us <= them) return false;
    }
    return true;
  };
  for (const st of steps) {
    const a = st.a;
    // streak and scoring bookkeeping
    if (a.actionType === '3pt' && a.personId) fire.set(a.personId, a.shotResult === 'Made' ? (fire.get(a.personId) || 0) + 1 : 0);
    if (st.pts && st.team) {
      const r = run.get(st.team);
      if (r && r.pid === a.personId) r.pts += st.pts; else run.set(st.team, { pid: a.personId, pts: st.pts, tagged: false });
      gamePts.set(a.personId, (gamePts.get(a.personId) || 0) + st.pts);
    }
    if (!(a.actionType === '2pt' || a.actionType === '3pt') || a.shotResult !== 'Made') continue;
    if (a.actionType === '3pt') gameThrees.set(a.personId, (gameThrees.get(a.personId) || 0) + 1);

    const secs = parseClock(a.clock), d = a.shotDistance != null && a.shotDistance !== '' ? Math.round(a.shotDistance) : null, pts = a.actionType === '3pt' ? 3 : 2;
    const isHome = a.teamTricode === home, us = isHome ? +a.scoreHome : +a.scoreAway, them = isHome ? +a.scoreAway : +a.scoreHome;
    const before = us - pts - them, after = us - them;
    const tags = [], extra = {};
    // distance
    if (d != null && d >= DIST.halfCourt) tags.push('HALF-COURT');
    else if (d != null && d >= DIST.heave) tags.push('HEAVE');
    else if (pts === 3 && d != null && d >= DIST.logo) tags.push('LOGO');
    // the clock
    if (secs != null && secs <= 1.0 && !(ctx.coarse && secs > 0)) tags.push('BUZZER');
    const late = a.period >= 4 && secs != null;
    if (late && secs <= 30 && before <= 0 && after > 0) tags.push(game.final && holds(st.i, a.teamTricode) ? 'GAME-WINNER' : 'GO-AHEAD');
    if (late && secs <= 60 && before >= 1 && before <= 3 && after >= 4 && (!game.final || holds(st.i, a.teamTricode))) tags.push('DAGGER');
    // and-ones
    const ft = actions.find(x => x.actionType === 'freethrow' && x.personId === a.personId && x.period === a.period && x.clock === a.clock && /1 of 1/.test(x.subType || ''));
    if (ft) tags.push(pts === 3 ? '4-PT PLAY' : 'AND-ONE');
    // streaks
    if (pts === 3 && (fire.get(a.personId) || 0) >= STREAK.fire) { tags.push('ON FIRE'); extra.fire = fire.get(a.personId); }
    const r = run.get(a.teamTricode);
    if (r && r.pid === a.personId && r.pts >= STREAK.takeover && !r.tagged) { tags.push('TAKEOVER'); r.tagged = true; extra.run = r.pts; }
    // career milestones (regular season only, when career totals are known)
    const base = regular && ctx.careerBefore ? ctx.careerBefore(a.personId) : null;
    if (base) {
      const nowP = base.pts + (gamePts.get(a.personId) || 0), wasP = nowP - (st.pts || pts);
      for (let v = Math.ceil((wasP + 1) / 5000) * 5000; v <= nowP; v += 5000) if (MS_STEPS.pts(v)) { extra.ms = (extra.ms ? extra.ms + ' · ' : '') + `${nth(v)} career point`; }
      if (pts === 3) { const t = base.tpm + (gameThrees.get(a.personId) || 0); if (MS_STEPS.tpm(t)) extra.ms = (extra.ms ? extra.ms + ' · ' : '') + `${nth(t)} career three`; }
      if (extra.ms) tags.push('MILESTONE');
    }
    if (!isRare(tags)) continue;
    const lat = a.xLegacy != null ? -a.xLegacy / 10 : null, outFt = a.yLegacy != null ? a.yLegacy / 10 : null;
    out.push({
      id: game.gameId + '-' + a.actionNumber, gameId: game.gameId, pid: a.personId, n: a.playerNameI || a.playerName,
      t: a.teamTricode, o: isHome ? away : home, q: period(a.period), secs, d,
      a: lat != null && outFt != null ? Math.round(Math.atan2(lat, Math.max(outFt, -4)) * 180 / Math.PI) : 0,
      shot: (a.subType || '').replace(/^\w/, c => c.toUpperCase()) + (a.descriptor ? ' · ' + a.descriptor : ''),
      sc: `${away} ${a.scoreAway}–${a.scoreHome} ${home}`, tags, ...extra, time: a.timeActual || '',
    });
  }
  return out;
}

// Counting helpers shared by the leaders tables.
export const isDeep = b => b.tags.includes('LOGO') || b.tags.includes('HEAVE') || b.tags.includes('HALF-COURT');
export const isClutch = b => b.tags.includes('GO-AHEAD') || b.tags.includes('GAME-WINNER');
// Buzzer-beating game-winner: a go-ahead make with 1.0 s or less left in the 4th quarter or overtime.
export const isHornWinner = b => b.tags.includes('BUZZER') && isClutch(b);
const seasonOfDate = iso => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7), s = m >= 9 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

// ---- Milestones ----
export const MILESTONES = {
  pts: { label: 'points', steps: [5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000] },
  reb: { label: 'rebounds', steps: [2500, 5000, 7500, 10000, 12500, 15000] },
  ast: { label: 'assists', steps: [2500, 5000, 7500, 8000, 10000, 12500, 15000] },
  tpm: { label: 'threes', steps: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000] },
  stl: { label: 'steals', steps: [1000, 1500, 2000, 2500] },
  blk: { label: 'blocks', steps: [1000, 1500, 2000, 2500, 3000] },
  td: { label: 'triple-doubles', steps: [10, 25, 50, 75, 100, 150, 200] },
};
export function nextMilestone(key, cur) {
  const m = MILESTONES[key]; const goal = m.steps.find(s => s > cur);
  if (!goal) return null;
  const idx = m.steps.indexOf(goal);
  return { goal, base: idx ? m.steps[idx - 1] : 0, need: goal - cur };
}

// ---- Badges (the Player's Vault) ----
// Each badge: {tier:'unicorn'|'rare'|'legend', span:'game'|'season'|'career', name, count?, detail}
const fmt = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
function gameBadge(nights, feat, tier, name, short) {
  const hits = nights.filter(n => n.feats.includes(feat)).sort((a, b) => a.date.localeCompare(b.date));
  if (!hits.length) return null;
  const f = hits[0], l = hits[hits.length - 1];
  return { tier, span: 'game', name, short, count: hits.length, detail: hits.length > 1 ? `First ${fmt(f.date)} · latest ${fmt(l.date)}` : `${fmt(f.date)} vs ${f.opp}` };
}
function listSeasons(list) { return list.length > 5 ? list.slice(0, 5).join(', ') + ' +' + (list.length - 5) + ' more' : list.join(', '); }

export function badges(pl) {
  const out = [], N = pl.nights || [], B = pl.buckets || [], A = pl.awards || [], S = pl.seasons || [], C = pl.career || {};
  const push = b => { if (b) out.push(b); };
  const dd = (pl.ddDates || []);
  // game
  push(gameBadge(N, 'QUADRUPLE-DOUBLE', 'unicorn', 'Quadruple-double', '4×10'));
  push(gameBadge(N, '60-POINT GAME', 'unicorn', '60-point game', '60'));
  push(gameBadge(N, '5x5', 'unicorn', '5x5 game', '5×5'));
  push(gameBadge(N, '50-POINT GAME', 'unicorn', '50-point game', '50'));
  push(gameBadge(N, 'TRIPLE-DOUBLE', 'rare', 'Triple-double', '3×10'));
  push(gameBadge(N, '40-POINT GAME', 'rare', '40-point game', '40'));
  push(gameBadge(N, '20-20', 'rare', '20-20 game', '20/20'));
  push(gameBadge(N, '10+ THREES', 'rare', 'Ten threes', '10'));
  push(gameBadge(N, '15+ ASSISTS', 'rare', '15 assists', '15'));
  push(gameBadge(N, '20+ REBOUNDS', 'rare', '20 rebounds', '20'));
  const latest = list => `Latest ${fmt(list[list.length - 1].date)} vs ${list[list.length - 1].o}`;
  const bz = B.filter(isHornWinner).sort((a, b) => a.date.localeCompare(b.date));
  if (bz.length) push({ tier: 'unicorn', span: 'game', name: 'Buzzer-beating game-winner', short: '0.0', count: bz.length, detail: latest(bz) });
  const bzBy = {}; bz.forEach(b => { const s = seasonOfDate(b.date); bzBy[s] = (bzBy[s] || 0) + 1; });
  const bzMulti = Object.keys(bzBy).filter(s => bzBy[s] >= 2).sort();
  if (bzMulti.length) push({ tier: 'unicorn', span: 'season', name: 'Two horn game-winners in a season', short: '2×', count: bzMulti.length, detail: bzMulti.map(s => `${s} (${bzBy[s]})`).join(', ') });
  if (bz.length >= 3) push({ tier: 'unicorn', span: 'career', name: 'Clutch at the horn', short: bz.length + '×', detail: `${bz.length} buzzer-beating game-winners` });
  const hc = B.filter(b => b.tags.includes('HALF-COURT'));
  if (hc.length) push({ tier: 'unicorn', span: 'game', name: 'Half-court make', short: Math.max(...hc.map(b => b.d)) + "'", count: hc.length, detail: `Deepest ${Math.max(...hc.map(b => b.d))} ft` });
  const gw = B.filter(b => b.tags.includes('GAME-WINNER'));
  if (gw.length) push({ tier: 'rare', span: 'game', name: 'Game-winner', short: 'GW', count: gw.length, detail: latest(gw) });
  const ms = B.filter(b => b.tags.includes('MILESTONE'));
  if (ms.length) push({ tier: 'rare', span: 'game', name: 'Milestone bucket', short: 'MS', count: ms.length, detail: ms.map(b => b.ms).slice(-2).join(' · ') });
  const of = B.filter(b => b.tags.includes('ON FIRE'));
  if (of.length) push({ tier: 'rare', span: 'game', name: 'On fire', short: Math.max(...of.map(b => b.fire || 5)) + '', count: new Set(of.map(b => b.gameId)).size, detail: `Best: ${Math.max(...of.map(b => b.fire || 5))} straight threes` });
  push(gameBadge(N, '20-POINT QUARTER', 'rare', '20-point quarter', '20Q'));
  const tk = B.filter(b => b.tags.includes('TAKEOVER'));
  if (tk.length) push({ tier: 'legend', span: 'game', name: 'Takeover', short: Math.max(...tk.map(b => b.run || 12)) + '', count: tk.length, detail: `Best: ${Math.max(...tk.map(b => b.run || 12))} straight team points` });
  const dg = B.filter(b => b.tags.includes('DAGGER'));
  if (dg.length) push({ tier: 'legend', span: 'game', name: 'Dagger', short: 'DGR', count: dg.length, detail: latest(dg) });
  const hv = B.filter(b => b.tags.includes('HEAVE'));
  if (hv.length) push({ tier: 'rare', span: 'game', name: 'Heave made', short: Math.max(...hv.map(b => b.d)) + "'", count: hv.length, detail: `Deepest ${Math.max(...hv.map(b => b.d))} ft` });
  const lg = B.filter(b => b.tags.includes('LOGO'));
  if (lg.length) push({ tier: 'legend', span: 'game', name: 'Logo three', short: '30+', count: lg.length, detail: `Deepest ${Math.max(...lg.map(b => b.d))} ft` });
  const ao = B.filter(b => b.tags.includes('4-PT PLAY'));
  if (ao.length) push({ tier: 'legend', span: 'game', name: 'Four-point play', short: '4', count: ao.length, detail: `Latest ${fmt(ao[ao.length - 1].date)}` });
  if (dd.length) push({ tier: 'legend', span: 'game', name: 'Double-double', short: '2×10', count: dd.length, detail: `First ${fmt(dd[0])} · latest ${fmt(dd[dd.length - 1])}` });
  if (pl.games30) push({ tier: 'legend', span: 'game', name: '30-point game', short: '30', count: pl.games30, detail: pl.logsPartial ? 'Since 1996-97' : 'Career' });
  push(gameBadge(N, '5+ STEALS', 'legend', 'Five steals', '5'));
  push(gameBadge(N, '5+ BLOCKS', 'legend', 'Five blocks', '5'));
  push(gameBadge(N, 'PERFECT FROM THE FIELD', 'legend', 'Perfect shooting night', '100%'));
  // season
  const aw = name => A.filter(a => a.name === name).map(a => a.season);
  const mvp = aw('NBA Most Valuable Player');
  if (mvp.length) push({ tier: 'unicorn', span: 'season', name: 'MVP award', short: 'MVP', count: mvp.length, detail: mvp.join(', ') });
  const tdAvg = S.filter(s => s.gp >= 58 && s.pts / s.gp >= 10 && s.reb / s.gp >= 10 && s.ast / s.gp >= 10).map(s => s.season);
  if (tdAvg.length) push({ tier: 'unicorn', span: 'season', name: 'Averaged a triple-double', short: '10/10/10', count: tdAvg.length, detail: tdAvg.join(', ') });
  const club5049 = S.filter(s => s.fga >= 300 && s.fg3a >= 82 && s.fta >= 125 && s.fgm / s.fga >= .5 && s.fg3m / s.fg3a >= .4 && s.ftm / s.fta >= .9).map(s => s.season);
  if (club5049.length) push({ tier: 'unicorn', span: 'season', name: '50-40-90 season', short: '50/40/90', count: club5049.length, detail: club5049.join(', ') });
  const p30 = S.filter(s => s.gp >= 58 && s.pts / s.gp >= 30).map(s => s.season);
  if (p30.length) push({ tier: 'rare', span: 'season', name: '30 points per game', short: '30', count: p30.length, detail: listSeasons(p30) });
  const allNba = aw('All-NBA');
  if (allNba.length) push({ tier: 'rare', span: 'season', name: 'All-NBA', short: 'ALL', count: allNba.length, detail: listSeasons(allNba) });
  const dpoy = aw('NBA Defensive Player of the Year');
  if (dpoy.length) push({ tier: 'rare', span: 'season', name: 'Defensive Player of the Year', short: 'DPOY', count: dpoy.length, detail: dpoy.join(', ') });
  const allStar = aw('NBA All-Star');
  if (allStar.length) push({ tier: 'legend', span: 'season', name: 'All-Star', short: 'ASG', count: allStar.length, detail: listSeasons(allStar) });
  const s2010 = S.filter(s => s.gp >= 58 && s.pts / s.gp >= 20 && s.reb / s.gp >= 10).map(s => s.season);
  if (s2010.length) push({ tier: 'legend', span: 'season', name: '20-10 season', short: '20/10', count: s2010.length, detail: listSeasons(s2010) });
  // career
  const fmv = aw('NBA Finals Most Valuable Player'), rings = aw('NBA Champion'), roy = aw('NBA Rookie of the Year');
  if (mvp.length > 1) push({ tier: 'unicorn', span: 'career', name: 'Multiple MVPs', short: mvp.length + '×', detail: mvp.length + ' MVP awards' });
  const careerMark = (key, val, tiers) => { tiers.forEach(([min, tier]) => { if (val >= min) push({ tier, span: 'career', name: min.toLocaleString() + ' ' + MILESTONES[key].label, short: min >= 1000 ? (min / 1000) + 'K' : String(min), detail: val.toLocaleString() + ' ' + MILESTONES[key].label }); }); };
  careerMark('pts', C.pts || 0, [[30000, 'unicorn'], [20000, 'rare'], [10000, 'legend']]);
  if (!pl.logsPartial) careerMark('td', C.td || 0, [[100, 'unicorn'], [50, 'rare'], [10, 'legend']]); // can't count triple-doubles before 1996-97
  careerMark('reb', C.reb || 0, [[10000, 'rare']]);
  careerMark('ast', C.ast || 0, [[10000, 'unicorn'], [5000, 'rare']]);
  careerMark('tpm', C.tpm || 0, [[3000, 'unicorn'], [2000, 'rare'], [1000, 'legend']]);
  if (fmv.length) push({ tier: 'rare', span: 'career', name: 'Finals MVP', short: 'FMVP', count: fmv.length, detail: fmv.join(', ') });
  if (rings.length) push({ tier: 'legend', span: 'career', name: 'Championship ring', short: rings.length + '×', detail: rings.length + ' ring' + (rings.length > 1 ? 's' : '') + ' · ' + rings.join(', ') });
  if (roy.length) push({ tier: 'legend', span: 'career', name: 'Rookie of the Year', short: 'ROY', detail: roy[0] });
  const order = { unicorn: 0, rare: 1, legend: 2 }, so = { game: 0, season: 1, career: 2 };
  return out.sort((a, b) => order[a.tier] - order[b.tier] || so[a.span] - so[b.span]);
}
