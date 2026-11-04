// Shared RimBlaze rules: what counts as a big night, a rare bucket, a badge and a milestone.
// The site pages use the same thresholds, so keep the two in step.

export const FEAT_WEIGHT = {
  'QUADRUPLE-DOUBLE': 100, '60-POINT GAME': 95, '5x5': 85, '50-POINT GAME': 75,
  'TRIPLE-DOUBLE': 60, '20-20': 55, '10+ THREES': 50, '40-POINT GAME': 45,
  '15+ ASSISTS': 40, '20+ REBOUNDS': 40, '5+ STEALS': 32, '5+ BLOCKS': 32,
  'PERFECT FROM THE FIELD': 28,
};

// p = {P,R,A,S,B,tpm,fgm,fga}
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

export function rareBuckets(actions, game) {
  const home = game.homeTeam.teamTricode, away = game.awayTeam.teamTricode, out = [];
  actions.forEach(a => {
    if (!(a.actionType === '2pt' || a.actionType === '3pt') || a.shotResult !== 'Made') return;
    const secs = parseClock(a.clock), d = a.shotDistance != null ? Math.round(a.shotDistance) : null, pts = a.actionType === '3pt' ? 3 : 2;
    const isHome = a.teamTricode === home, us = isHome ? +a.scoreHome : +a.scoreAway, them = isHome ? +a.scoreAway : +a.scoreHome;
    const tags = [];
    if (d != null && d >= 40) tags.push('HEAVE'); else if (pts === 3 && d != null && d >= 30) tags.push('LOGO');
    if (secs != null && secs <= 1.0) tags.push('BUZZER');
    if (a.period >= 4 && secs != null && secs <= 30 && us - pts <= them && us > them) tags.push('GO-AHEAD');
    const ft = actions.find(x => x.actionType === 'freethrow' && x.personId === a.personId && x.period === a.period && x.clock === a.clock && /1 of 1/.test(x.subType || ''));
    if (ft) tags.push(pts === 3 ? '4-PT PLAY' : 'AND-ONE');
    if (!isRare(tags)) return;
    const lat = a.xLegacy != null ? -a.xLegacy / 10 : null, outFt = a.yLegacy != null ? a.yLegacy / 10 : null;
    out.push({
      id: game.gameId + '-' + a.actionNumber, gameId: game.gameId, pid: a.personId, n: a.playerNameI || a.playerName,
      t: a.teamTricode, o: isHome ? away : home, q: period(a.period), secs, d,
      a: lat != null && outFt != null ? Math.round(Math.atan2(lat, Math.max(outFt, -4)) * 180 / Math.PI) : 0,
      shot: (a.subType || '').replace(/^\w/, c => c.toUpperCase()) + (a.descriptor ? ' · ' + a.descriptor : ''),
      sc: `${away} ${a.scoreAway}–${a.scoreHome} ${home}`, tags, time: a.timeActual || '',
    });
  });
  return out;
}

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
  const bz = B.filter(b => b.tags.includes('BUZZER') && b.tags.includes('GO-AHEAD'));
  if (bz.length) push({ tier: 'unicorn', span: 'game', name: 'Game-winner at the horn', short: '0.0', count: bz.length, detail: `Latest ${fmt(bz[bz.length - 1].date)} vs ${bz[bz.length - 1].o}` });
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
