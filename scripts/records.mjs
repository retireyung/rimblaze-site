// NBA records pages: /records/ and one page per record, fully static.
//
// Two sources:
//   data/records.json   single-game, single-season and career feat records from every regular-season
//                       game log since 1996-97 (written by build-stats.mjs on the home PC, see gameRecords)
//   data/buckets/*.json rare buckets and data/quarters/*.json 20-point quarters (read here directly)
//   data/career.json    the milestone watch
//
// Every board says what it covers: NBA.com game logs and play-by-play begin in 1996-97, so nothing
// here claims an all-time record unless it is one.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tens, isDeep, isClutch, isHornWinner } from './feats.mjs';
import { seasonList } from './nba.mjs';
import { teamSlug } from './teams.mjs';
import { SITE, esc, num, page, crumbsLd, fmtShort, ld } from './shell.mjs';

const FIRST = '1996-97';

// ---------- 1. Records from game logs (runs inside build-stats.mjs) ----------
export const FEATS = [
  { key: 'td', test: l => tens(l) >= 3, one: 'triple-double', many: 'triple-doubles' },
  { key: 'dd', test: l => tens(l) >= 2, one: 'double-double', many: 'double-doubles' },
  { key: 'p30', test: l => l.P >= 30, one: '30-point game', many: '30-point games' },
  { key: 'p40', test: l => l.P >= 40, one: '40-point game', many: '40-point games' },
  { key: 'p50', test: l => l.P >= 50, one: '50-point game', many: '50-point games' },
  { key: 'r20', test: l => l.R >= 20, one: '20-rebound game', many: '20-rebound games' },
  { key: 'a15', test: l => l.A >= 15, one: '15-assist game', many: '15-assist games' },
  { key: 't10', test: l => l.tpm >= 10, one: 'game with 10+ threes', many: 'games with 10+ threes' },
];
export const STREAKS = [
  { key: 'dds', test: l => tens(l) >= 2, label: 'double-double streak' },
  { key: 'p30s', test: l => l.P >= 30, label: '30-point streak' },
];
const GAME_STATS = [['P', 'points'], ['R', 'rebounds'], ['A', 'assists'], ['tpm', 'threes'], ['S', 'steals'], ['B', 'blocks']];
const slim = l => ({ pid: l.pid, n: l.n, t: l.t, o: l.opp, h: l.home ? 1 : 0, wl: l.wl, date: l.date, g: l.gameId, P: l.P, R: l.R, A: l.A, S: l.S, B: l.B, tpm: l.tpm, fgm: l.fgm, fga: l.fga, min: l.min });

// allLines: every regular-season player game since 1996-97 ({pid,n,t,date,gameId,opp,home,wl,P,R,A,S,B,tpm,fgm,fga,min,season})
// fromYear: Map pid -> first NBA season start year, where known (profiles), to flag careers that began before 1996-97
export function gameRecords(allLines, { season, fromYear = new Map() }) {
  const byPlayer = new Map(), names = {};
  for (const l of allLines) { if (!byPlayer.has(l.pid)) byPlayer.set(l.pid, []); byPlayer.get(l.pid).push(l); names[l.pid] = l.n; }
  const feats = {}, streaks = {};
  FEATS.forEach(f => feats[f.key] = { career: [], season: [], current: [] });
  STREAKS.forEach(s => streaks[s.key] = { season: [], current: [] });
  for (const [pid, ls] of byPlayer) {
    ls.sort((a, b) => a.date.localeCompare(b.date));
    const first = ls[0].season, last = ls[ls.length - 1].season, fy = fromYear.get(pid);
    const partial = first === FIRST && (fy == null || +fy < 1996);
    const bySeason = new Map();
    ls.forEach(l => { if (!bySeason.has(l.season)) bySeason.set(l.season, []); bySeason.get(l.season).push(l); });
    for (const f of FEATS) {
      const v = ls.filter(f.test).length;
      if (v) feats[f.key].career.push({ pid, n: ls[ls.length - 1].n, v, gp: ls.length, from: first, to: last, partial });
      for (const [s, sl] of bySeason) {
        const sv = sl.filter(f.test).length; if (!sv) continue;
        const row = { pid, n: sl[0].n, t: sl[sl.length - 1].t, s, v: sv, gp: sl.length };
        feats[f.key].season.push(row);
        if (s === season) feats[f.key].current.push(row);
      }
    }
    for (const st of STREAKS) for (const [s, sl] of bySeason) {
      let run = 0, best = 0, bestEnd = null, start = null, bestStart = null;
      sl.forEach(l => { if (st.test(l)) { if (!run) start = l.date; run++; if (run > best) { best = run; bestEnd = l.date; bestStart = start; } } else run = 0; });
      if (best) streaks[st.key].season.push({ pid, n: sl[0].n, t: sl[sl.length - 1].t, s, v: best, from: bestStart, to: bestEnd });
      if (s === season && run) streaks[st.key].current.push({ pid, n: sl[0].n, t: sl[sl.length - 1].t, v: run, best });
    }
  }
  const top = (list, k = 50) => list.sort((a, b) => b.v - a.v || (a.gp || 0) - (b.gp || 0) || String(a.s || a.from).localeCompare(String(b.s || b.from))).slice(0, k);
  for (const f of FEATS) { const F = feats[f.key]; top(F.career); F.career = F.career.slice(0, 50); F.season = top(F.season); F.current = top(F.current, 25); }
  for (const s of STREAKS) { const S = streaks[s.key]; S.season = top(S.season); S.current = top(S.current, 15); }
  const games = {};
  for (const [k] of GAME_STATS) games[k] = allLines.slice().sort((a, b) => b[k] - a[k] || b.P - a.P || a.date.localeCompare(b.date)).slice(0, 50).map(slim);
  const cur = allLines.filter(l => l.season === season);
  const currentGames = {};
  for (const [k] of GAME_STATS) currentGames[k] = cur.slice().sort((a, b) => b[k] - a[k] || b.P - a.P || a.date.localeCompare(b.date)).slice(0, 10).map(slim);
  const fifty = allLines.filter(l => l.P >= 50).sort((a, b) => b.date.localeCompare(a.date)).map(slim);
  return { season, since: FIRST, seasons: [...new Set(allLines.map(l => l.season))].sort(), games, currentGames, fifty, feats, streaks, names };
}

// ---------- 2. Rare-bucket records (from the per-season files) ----------
// Old play-by-play has a few impossible shot locations (a 1,640-foot jumper, 70-footers in mid-quarter).
const validDist = b => b.d != null && b.d <= 94 && !(b.d >= 40 && (b.secs == null || b.secs > 4));
async function readJSON(f, dflt = null) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return dflt; } }

async function rareData(root, season) {
  const dir = path.join(root, 'data', 'buckets');
  const files = (await readdir(dir).catch(() => [])).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort();
  const all = [];
  for (const f of files) for (const b of (await readJSON(path.join(dir, f), [])) || []) all.push({ ...b, s: f.slice(0, 7) });
  const qdir = path.join(root, 'data', 'quarters'), quarters = [];
  for (const f of (await readdir(qdir).catch(() => [])).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort())
    for (const q of (await readJSON(path.join(qdir, f), [])) || []) quarters.push({ ...q, s: f.slice(0, 7) });
  const have = new Set(files.map(f => f.slice(0, 7)));
  const missing = seasonList(FIRST, season).filter(s => !have.has(s));
  // Quarter scoring is reliable for seasons rebuilt with rules v3+ (which read archived play-by-play correctly),
  // seasons from NBA.com's live feed (2017-18 on) and this season. Use the unbroken run ending this season.
  const rules = (await readJSON(path.join(dir, 'rules.json'), {})) || {};
  const okQ = s => (rules[s] || 0) >= 3 || s >= '2017-18' || s === season;
  let qFrom = season; for (const s of seasonList(FIRST, season).reverse()) { if (!okQ(s)) break; qFrom = s; }
  return { all, quarters: quarters.filter(q => q.s >= qFrom), qFrom, missing, seasons: [...have].sort() };
}
function leaders(list, test, k = 25) {
  const by = new Map();
  for (const b of list) if (test(b)) { const r = by.get(b.pid) || { pid: b.pid, n: b.n, t: b.t, v: 0, from: b.s, to: b.s }; r.v++; r.t = b.t; r.to = b.s; by.set(b.pid, r); }
  return [...by.values()].sort((a, b) => b.v - a.v || a.from.localeCompare(b.from)).slice(0, k);
}
function seasonLeaders(list, test, k = 25) {
  const by = new Map();
  for (const b of list) if (test(b)) { const key = b.pid + '|' + b.s; const r = by.get(key) || { pid: b.pid, n: b.n, t: b.t, s: b.s, v: 0 }; r.v++; by.set(key, r); }
  return [...by.values()].sort((a, b) => b.v - a.v || a.s.localeCompare(b.s)).slice(0, k);
}

// ---------- 3. Page pieces ----------
const clock = s => s == null ? '' : s < 60 ? `0:${s < 10 ? '0' : ''}${Number(s).toFixed(1)}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const tlink = abbr => teamSlug(abbr) ? `<a href="/teams/${teamSlug(abbr)}/">${esc(abbr)}</a>` : esc(abbr || '');
const nlink = d => `<a href="/nights/${d}/">${esc(fmtShort(d))}</a>`;
function ctx(slugs, names) {
  const name = (pid, n) => names[pid] || n || '';
  const who = (pid, n) => { const s = slugs.get(pid), nm = esc(name(pid, n)); return s ? `<a href="/players/${s}/"><b>${nm}</b></a>` : `<b>${nm}</b>`; };
  return { name, who };
}
// A cell written as <span class="big|rk|n">x</span> becomes <td class="...">x</td> so the table styles apply.
const cell = c => { const m = /^<span class="(big|rk|n)">([\s\S]*)<\/span>$/.exec(c); return m ? `<td class="${m[1]}">${m[2]}</td>` : `<td>${c}</td>`; };
const table = (heads, rows, empty = 'Nothing yet.') => rows.length
  ? `<div class="card tbl"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table></div>`
  : `<div class="card empty">${empty}</div>`;
// rank with ties (1, 2, 2, 4)
const ranks = (rows, key = 'v') => { let last = null, r = 0; return rows.map((x, i) => { if (x[key] !== last) { r = i + 1; last = x[key]; } return r; }); };
const andList = a => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const ties = (rows, name) => rows.filter(r => r.v === rows[0].v).map(r => name(r.pid, r.n));
function faqBlock(qa) {
  if (!qa.length) return { html: '', ld: null };
  return {
    html: `<section><h2>Quick answers</h2><div class="card faq">${qa.map(([q, a]) => `<details open><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>`,
    ld: { '@type': 'FAQPage', mainEntity: qa.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  };
}
const EXTRA_CSS = `<style>.faq details{padding:12px 16px;border-bottom:1px solid var(--line)}.faq details:last-child{border-bottom:0}.faq summary{font-weight:600;cursor:pointer}.faq p{margin:6px 0 0;color:var(--muted)}
.rel{display:flex;flex-wrap:wrap;gap:8px}.rel a{border:1px solid var(--line);background:var(--surface);border-radius:3px;padding:8px 12px;font-size:14px}.rel a:hover{border-color:var(--leather)}
.hub{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))}.hub a{display:grid;gap:4px;padding:14px 16px}.hub a b{font-size:16px}.hub a span{font-size:13px;color:var(--muted)}.hub a:hover{border-color:var(--leather)}
td.rk{font:600 13px "IBM Plex Mono",monospace;color:var(--muted);width:44px}</style>`;

// ---------- 4. The pages ----------
// group: hub section · slug · short label for links and the hub
const PAGES = [];
const def = (group, slug, label, blurb, build) => PAGES.push({ group, slug, label, blurb, build });

function shell({ slug, title, desc, h1, lead, strip = '', sections, qa = [], related, items = [], crumb }) {
  const url = `${SITE}/records/${slug}/`, faq = faqBlock(qa);
  const graph = [
    { '@type': 'CollectionPage', '@id': url + '#page', url, name: title, description: desc, isPartOf: { '@id': SITE + '/#site' }, dateModified: new Date().toISOString().slice(0, 10),
      ...(items.length ? { mainEntity: { '@type': 'ItemList', name: crumb, numberOfItems: items.length, itemListElement: items.slice(0, 25).map((name, i) => ({ '@type': 'ListItem', position: i + 1, name })) } } : {}) },
    crumbsLd([['RimBlaze', SITE + '/'], ['NBA records', SITE + '/records/'], [crumb, url]]),
    ...(faq.ld ? [faq.ld] : []),
  ];
  const rel = PAGES.filter(p => related.includes(p.slug));
  const body = `${EXTRA_CSS}<div class="crumbs"><a href="/">RimBlaze</a> / <a href="/records/">NBA records</a> / ${esc(crumb)}</div>
<h1>${h1}</h1>
<p class="lead">${esc(lead)}</p>
${strip}
${sections.join('\n')}
${faq.html}
<section><h2>More NBA records</h2><div class="rel">${rel.map(p => `<a href="/records/${p.slug}/">${esc(p.label)}</a>`).join('')}<a href="/all-time/">All-time career leaders</a><a href="/records/">Every record</a></div></section>`;
  return { url, html: page({ title, desc, url, graph, body, current: 'records' }) };
}
const stripOf = cells => `<div class="strip">${cells.map(([k, v, s]) => `<div><span class="k">${esc(k)}</span><span class="v">${v}</span><span class="s">${s}</span></div>`).join('')}</div>`;

// Single-game boards
const GAME_PAGES = [
  ['P', 'points', 'most-points-in-a-game', 'Most points in a game', 'Most Points in an NBA Game: Top 50 Scoring Games Since 1996-97'],
  ['R', 'rebounds', 'most-rebounds-in-a-game', 'Most rebounds in a game', 'Most Rebounds in an NBA Game: Top 50 Since 1996-97'],
  ['A', 'assists', 'most-assists-in-a-game', 'Most assists in a game', 'Most Assists in an NBA Game: Top 50 Since 1996-97'],
  ['tpm', 'threes', 'most-threes-in-a-game', 'Most threes in a game', 'Most 3-Pointers Made in an NBA Game: Top 50 Since 1996-97'],
  ['S', 'steals', 'most-steals-in-a-game', 'Most steals in a game', 'Most Steals in an NBA Game: Top 50 Since 1996-97'],
  ['B', 'blocks', 'most-blocks-in-a-game', 'Most blocks in a game', 'Most Blocks in an NBA Game: Top 50 Since 1996-97'],
];
const statCol = { P: 'PTS', R: 'REB', A: 'AST', tpm: '3PM', S: 'STL', B: 'BLK' };
const lineOf = g => `${g.P} pts, ${g.R} reb, ${g.A} ast${g.tpm ? `, ${g.tpm} 3PM` : ''}`;
for (const [k, word, slug, label, title] of GAME_PAGES) def('game', slug, label, `The 50 biggest ${word} games`, D => {
  const G = D.rec?.games?.[k]; if (!G?.length) return null;
  const { who, name } = D.c, top = G[0], rk = ranks(G.map(g => ({ v: g[k] })));
  const curTop = D.rec.currentGames?.[k]?.[0];
  const desc = `The most ${word} in an NBA game since 1996-97: ${name(top.pid, top.n)}'s ${top[k]} on ${fmtShort(top.date)}, plus the top 50 single-game ${word} performances and this season's best, updated after every game.`;
  const rows = G.map((g, i) => [`<span class="rk">${rk[i]}</span>`, who(g.pid, g.n), `<span class="big">${g[k]}</span>`, `${tlink(g.t)} ${g.h ? 'vs' : '@'} ${tlink(g.o)}`, D.nights.has(g.date) ? nlink(g.date) : esc(fmtShort(g.date)), `<span class="meta">${esc(lineOf(g))} · ${g.wl || ''}</span>`]);
  const cur = (D.rec.currentGames?.[k] || []).map(g => [who(g.pid, g.n), `<span class="big">${g[k]}</span>`, `${tlink(g.t)} ${g.h ? 'vs' : '@'} ${tlink(g.o)}`, D.nights.has(g.date) ? nlink(g.date) : esc(fmtShort(g.date)), `<span class="meta">${esc(lineOf(g))}</span>`]);
  const qa = [[`What is the most ${word} in an NBA game since 1996-97?`, `${top[k]}, by ${name(top.pid, top.n)} (${top.t}) ${top.h ? 'vs' : 'at'} ${top.o} on ${fmtShort(top.date)}. NBA.com game logs are complete from the 1996-97 season on.`]];
  if (curTop) qa.push([`What is the most ${word} in a game this season (${D.season})?`, `${curTop[k]}, by ${name(curTop.pid, curTop.n)} (${curTop.t}) ${curTop.h ? 'vs' : 'at'} ${curTop.o} on ${fmtShort(curTop.date)}.`]);
  const n40 = k === 'P' ? G.filter(g => g.P >= 70).length : null;
  if (n40) qa.push(['How many 70-point games have there been since 1996-97?', `${n40}: ${andList(G.filter(g => g.P >= 70).map(g => `${name(g.pid, g.n)} (${g.P}, ${fmtShort(g.date)})`))}.`]);
  return shell({ slug, title: `${title} | RimBlaze`, desc, crumb: label, h1: `Most ${word} <em>in a game.</em>`,
    lead: `The top 50 single-game ${word} totals in the NBA regular season since 1996-97, when NBA.com's complete game logs begin, with this season's best. Updated after every game night.`,
    strip: stripOf([['Record since 1996-97', top[k], `${esc(name(top.pid, top.n))} · ${esc(fmtShort(top.date))}`], ['This season', curTop ? curTop[k] : '—', curTop ? `${esc(name(curTop.pid, curTop.n))} · ${esc(fmtShort(curTop.date))}` : 'No games yet'], ['Games on the list', G.length, `${G[G.length - 1][k]}+ ${word}`], ['Seasons covered', D.rec.seasons.length, `${D.rec.seasons[0]} to ${D.season}`]]),
    sections: [`<section><h2>Top 50 since 1996-97</h2>${table(['#', 'Player', statCol[k], 'Game', 'Date', 'Line'], rows)}</section>`,
      `<section><h2>Best this season (${esc(D.season)})</h2>${table(['Player', statCol[k], 'Game', 'Date', 'Line'], cur, 'No games played yet this season.')}</section>`],
    qa, related: GAME_PAGES.map(g => g[2]).filter(s => s !== slug).concat(k === 'P' ? ['50-point-games', '40-point-games'] : []), items: G.map(g => `${name(g.pid, g.n)}: ${g[k]} ${word}, ${fmtShort(g.date)}`) });
});

// Feat boards: career (since 1996-97), single season, this season
const FEAT_PAGES = {
  td: ['triple-doubles', 'Triple-doubles', 'NBA Triple-Double Records: Most in a Season & Career Since 1996-97', 'Triple-double <em>records.</em>'],
  dd: ['double-doubles', 'Double-doubles', 'Most Double-Doubles in a Season & Career: NBA Records Since 1996-97', 'Double-double <em>records.</em>'],
  p30: ['30-point-games', '30-point games', 'Most 30-Point Games in a Season & Career: NBA Records Since 1996-97', '30-point <em>games.</em>'],
  p40: ['40-point-games', '40-point games', 'Most 40-Point Games in a Season & Career: NBA Records Since 1996-97', '40-point <em>games.</em>'],
  p50: ['50-point-games', '50-point games', 'Every 50-Point Game in the NBA Since 1996-97, Plus Every 60-Point Game', 'Every 50-point <em>game.</em>'],
  r20: ['20-rebound-games', '20-rebound games', 'Most 20-Rebound Games in a Season & Career: NBA Records Since 1996-97', '20-rebound <em>games.</em>'],
  a15: ['15-assist-games', '15-assist games', 'Most 15-Assist Games in a Season & Career: NBA Records Since 1996-97', '15-assist <em>games.</em>'],
  t10: ['10-three-games', 'Games with 10+ threes', 'Most Games With 10 or More 3-Pointers: NBA Records Since 1996-97', '10-three <em>games.</em>'],
};
for (const f of FEATS) {
  const [slug, label, title, h1] = FEAT_PAGES[f.key];
  def('feat', slug, label, `Most ${f.many} in a season and career`, D => {
    const F = D.rec?.feats?.[f.key]; if (!F?.season?.length) return null;
    const { who, name } = D.c, S = F.season, C = F.career, cur = F.current;
    const sTop = ties(S, name), cTop = ties(C, name);
    const desc = `Most ${f.many} in an NBA season since 1996-97: ${andList(sTop)} with ${S[0].v}. Career leader: ${andList(cTop)} (${C[0].v}). Plus this season's ${f.many} leaders, updated after every game.`;
    const rkC = ranks(C), rkS = ranks(S);
    const cRows = C.map((r, i) => [`<span class="rk">${rkC[i]}</span>`, who(r.pid, r.n) + (r.partial ? ' <span class="meta">*</span>' : ''), `<span class="big">${r.v}</span>`, `<span class="n">${r.gp}</span>`, `<span class="meta">${esc(r.from)} to ${esc(r.to)}</span>`]);
    const sRows = S.map((r, i) => [`<span class="rk">${rkS[i]}</span>`, who(r.pid, r.n), `<span class="big">${r.v}</span>`, esc(r.s), tlink(r.t), `<span class="n">${r.gp}</span>`]);
    const nowRows = cur.map(r => [who(r.pid, r.n), `<span class="big">${r.v}</span>`, tlink(r.t), `<span class="n">${r.gp}</span>`]);
    const qa = [[`Who has the most ${f.many} in a single NBA season since 1996-97?`, `${andList(S.filter(r => r.v === S[0].v).map(r => `${name(r.pid, r.n)} (${r.s})`))}, with ${S[0].v}.`],
      [`Who has the most career ${f.many} since 1996-97?`, `${andList(cTop)}, with ${C[0].v} in regular-season games since 1996-97.${C[0].partial ? ' His career began before 1996-97, so earlier games are not counted.' : ''}`]];
    if (cur.length) qa.push([`Who leads the NBA in ${f.many} this season?`, `${andList(ties(cur, name))}, with ${cur[0].v} in ${D.season}.`]);
    const sections = [];
    if (f.key === 'p50') {
      const L = D.rec.fifty || [], sixty = L.filter(g => g.P >= 60).sort((a, b) => b.P - a.P || a.date.localeCompare(b.date));
      sections.push(`<section><h2>Every 60-point game since 1996-97</h2>${table(['Player', 'PTS', 'Game', 'Date', 'Line'], sixty.map(g => [who(g.pid, g.n), `<span class="big">${g.P}</span>`, `${tlink(g.t)} ${g.h ? 'vs' : '@'} ${tlink(g.o)}`, D.nights.has(g.date) ? nlink(g.date) : esc(fmtShort(g.date)), `<span class="meta">${esc(lineOf(g))}</span>`]))}</section>`);
      sections.push(`<section><h2>Every 50-point game, newest first (${L.length})</h2>${table(['Player', 'PTS', 'Game', 'Date', 'Line'], L.map(g => [who(g.pid, g.n), `<span class="big">${g.P}</span>`, `${tlink(g.t)} ${g.h ? 'vs' : '@'} ${tlink(g.o)}`, D.nights.has(g.date) ? nlink(g.date) : esc(fmtShort(g.date)), `<span class="meta">${esc(lineOf(g))} · ${g.wl || ''}</span>`]))}</section>`);
      qa.push(['How many 50-point games have there been since 1996-97?', `${L.length} in the regular season, ${sixty.length} of them 60 points or more.`]);
    }
    sections.push(`<section><h2>This season (${esc(D.season)})</h2>${table(['Player', label, 'Team', 'Games'], nowRows, `No ${f.many} yet this season.`)}</section>`,
      `<section><h2>Most in a single season</h2>${table(['#', 'Player', label, 'Season', 'Team', 'Games'], sRows)}</section>`,
      `<section><h2>Most in a career since 1996-97</h2>${table(['#', 'Player', label, 'Games', 'Seasons'], cRows)}<p class="note">* Career began before 1996-97; only games since then are counted. Regular season only.</p></section>`);
    if (f.key === 'p50') sections.unshift(sections.splice(2, 1)[0]); // this season first
    return shell({ slug, title: `${title} | RimBlaze`, desc, crumb: label, h1,
      lead: `Every ${f.one} in the NBA regular season since 1996-97, when NBA.com's complete game logs begin: the single-season and career leaders, and this season's race. Updated after every game night.`,
      strip: stripOf([['Season record', S[0].v, `${esc(andList(sTop))} · ${esc(S[0].s)}`], ['Career leader', C[0].v, esc(andList(cTop))], ['This season', cur[0]?.v ?? 0, cur.length ? esc(andList(ties(cur, name))) : 'None yet'], ['Since', '96-97', `${D.rec.seasons.length} seasons of game logs`]]),
      sections, qa, related: Object.values(FEAT_PAGES).map(p => p[0]).filter(s => s !== slug).concat(['milestone-watch']),
      items: S.map(r => `${name(r.pid, r.n)}: ${r.v} ${f.many}, ${r.s}`) });
  });
}

// Streaks
const STREAK_PAGES = { dds: ['double-double-streaks', 'Double-double streaks', 'Longest Double-Double Streaks in an NBA Season Since 1996-97'], p30s: ['30-point-streaks', '30-point streaks', 'Longest 30-Point Game Streaks in an NBA Season Since 1996-97'] };
for (const st of STREAKS) {
  const [slug, label, title] = STREAK_PAGES[st.key];
  def('feat', slug, label, `Longest ${st.label}s`, D => {
    const S = D.rec?.streaks?.[st.key]; if (!S?.season?.length) return null;
    const { who, name } = D.c, top = S.season[0], rk = ranks(S.season);
    const desc = `The longest ${st.label} in an NBA season since 1996-97 is ${top.v} games, by ${name(top.pid, top.n)} (${top.s}). Every top streak, plus the active streaks this season.`;
    const qa = [[`What is the longest ${st.label} in one NBA season since 1996-97?`, `${top.v} straight games, by ${name(top.pid, top.n)} in ${top.s} (${fmtShort(top.from)} to ${fmtShort(top.to)}).`]];
    if (S.current[0]) qa.push([`Who has the longest active ${st.label}?`, `${name(S.current[0].pid, S.current[0].n)}, ${S.current[0].v} straight games in ${D.season}.`]);
    return shell({ slug, title: `${title} | RimBlaze`, desc, crumb: label, h1: `${esc(label)}.`,
      lead: `The longest runs of straight regular-season games with a ${st.label.replace(' streak', '')} within one season since 1996-97, and every active streak this season.`,
      strip: stripOf([['Longest since 1996-97', top.v, `${esc(name(top.pid, top.n))} · ${esc(top.s)}`], ['Longest active', S.current[0]?.v ?? 0, S.current[0] ? esc(name(S.current[0].pid, S.current[0].n)) : 'None right now']]),
      sections: [`<section><h2>Active streaks (${esc(D.season)})</h2>${table(['Player', 'Streak', 'Team', 'Season best'], S.current.map(r => [who(r.pid, r.n), `<span class="big">${r.v}</span>`, tlink(r.t), `<span class="n">${r.best}</span>`]), 'No active streaks right now.')}</section>`,
        `<section><h2>Longest in a season since 1996-97</h2>${table(['#', 'Player', 'Games', 'Season', 'Team', 'Dates'], S.season.map((r, i) => [`<span class="rk">${rk[i]}</span>`, who(r.pid, r.n), `<span class="big">${r.v}</span>`, esc(r.s), tlink(r.t), `<span class="meta">${esc(fmtShort(r.from))} to ${esc(fmtShort(r.to))}</span>`]))}</section>`],
      qa, related: ['double-doubles', '30-point-games', 'double-double-streaks', '30-point-streaks'].filter(s => s !== slug),
      items: S.season.map(r => `${name(r.pid, r.n)}: ${r.v} straight, ${r.s}`) });
  });
}

// Rare buckets
function coverage(D) {
  const R = D.rare;
  return `Regular-season play-by-play from ${R.seasons[0]} to ${D.season}${R.missing.length ? ` (${R.missing.join(', ')} not yet in our archive)` : ''}.`;
}
function rarePage({ slug, label, blurb, title, h1, test, word, lead, extra, qaFn, related }) {
  def('rare', slug, label, blurb, D => {
    const R = D.rare; if (!R.all.length) return null;
    const { who, name } = D.c, C = leaders(R.all, test), S = seasonLeaders(R.all, test), now = leaders(R.all.filter(b => b.s === D.season), test, 15);
    if (!C.length) return null;
    const rkC = ranks(C), rkS = ranks(S), total = R.all.filter(test).length;
    const desc = `${label} since ${R.seasons[0]}: ${andList(ties(C, name))} leads with ${C[0].v}. Career and single-season leaders, plus every ${word} this season, updated after every game.`;
    const qa = [[`Who has the most ${word}s since ${R.seasons[0]}?`, `${andList(ties(C, name))}, with ${C[0].v} in the regular season. ${coverage(D)}`],
      [`Who has the most ${word}s in one season?`, `${andList(S.filter(r => r.v === S[0].v).map(r => `${name(r.pid, r.n)} (${r.s})`))}, with ${S[0].v}.`]];
    if (now.length) qa.push([`Who has the most ${word}s this season?`, `${andList(ties(now, name))}, with ${now[0].v} in ${D.season}.`]);
    if (qaFn) qa.push(...qaFn(D));
    return shell({ slug, title: `${title} | RimBlaze`, desc, crumb: label, h1, lead,
      strip: stripOf([['Career leader', C[0].v, esc(andList(ties(C, name)))], ['Season record', S[0].v, `${esc(name(S[0].pid, S[0].n))} · ${esc(S[0].s)}`], ['This season', now[0]?.v ?? 0, now.length ? esc(andList(ties(now, name))) : 'None yet'], ['Tracked', num(total), `${word}s since ${R.seasons[0]}`]]),
      sections: [...(extra ? extra(D) : []),
        `<section><h2>Leaders this season (${esc(D.season)})</h2>${table(['Player', 'Total', 'Team'], now.map(r => [who(r.pid, r.n), `<span class="big">${r.v}</span>`, tlink(r.t)]), `No ${word}s yet this season.`)}</section>`,
        `<section><h2>Most since ${esc(R.seasons[0])}</h2>${table(['#', 'Player', 'Total', 'Seasons'], C.map((r, i) => [`<span class="rk">${rkC[i]}</span>`, who(r.pid, r.n), `<span class="big">${r.v}</span>`, `<span class="meta">${esc(r.from)} to ${esc(r.to)}</span>`]))}<p class="note">${esc(coverage(D))}</p></section>`,
        `<section><h2>Most in one season</h2>${table(['#', 'Player', 'Total', 'Season', 'Team'], S.map((r, i) => [`<span class="rk">${rkS[i]}</span>`, who(r.pid, r.n), `<span class="big">${r.v}</span>`, esc(r.s), tlink(r.t)]))}</section>`],
      qa, related, items: C.map(r => `${name(r.pid, r.n)}: ${r.v}`) });
  });
}
const shotRows = (D, list) => list.map(b => [D.c.who(b.pid, b.n), `<span class="big">${b.d ?? '—'}</span>`, `${tlink(b.t)} vs ${tlink(b.o)}`, D.nights.has(b.date) ? nlink(b.date) : esc(fmtShort(b.date)), `<span class="n">${esc(b.q)} ${clock(b.secs)}</span>`, `<div class="badges">${b.tags.map((t, i) => `<span class="badge${i ? ' alt' : ''}">${esc(t)}</span>`).join('')}</div>`]);
const RARE_REL = ['buzzer-beating-game-winners', 'buzzer-beaters', 'game-winners', 'logo-threes', 'longest-shots', 'four-point-plays', '20-point-quarters'];
rarePage({ slug: 'buzzer-beaters', label: 'Buzzer-beaters', blurb: 'Most shots made at the horn', title: 'NBA Buzzer-Beater Leaders: Most Buzzer-Beaters Since 1996-97', word: 'buzzer-beater',
  h1: 'Buzzer-<em>beaters.</em>', test: b => b.tags.includes('BUZZER'),
  lead: 'Every made shot with one second or less on the clock at the end of a quarter or overtime, from NBA.com play-by-play since 1996-97: career and single-season leaders and this season\'s list.',
  extra: () => [`<section><p class="lead" style="font-size:15px">Looking for the ones that won the game? See <a class="cnt" href="/records/buzzer-beating-game-winners/">every buzzer-beating game-winner</a>.</p></section>`],
  related: RARE_REL.filter(s => s !== 'buzzer-beaters') });
rarePage({ slug: 'buzzer-beating-game-winners', label: 'Buzzer-beating game-winners', blurb: 'Go-ahead shots at the final horn', title: 'Buzzer-Beating Game-Winners: Every One Since 1996-97 and the Career Leaders', word: 'buzzer-beating game-winner',
  h1: 'Game-winners <em>at the horn.</em>', test: isHornWinner,
  lead: 'Every go-ahead shot made with one second or less left in the fourth quarter or overtime, from NBA.com play-by-play since 1996-97: the career and single-season leaders, and the complete list. One of the rarest shots in basketball, about 20 a season across the whole league.',
  extra: D => { const w = D.rare.all.filter(isHornWinner).sort((a, b) => b.date.localeCompare(a.date) || (a.secs ?? 9) - (b.secs ?? 9));
    return [`<section><h2>Every buzzer-beating game-winner, newest first (${w.length})</h2>${table(['Player', 'Feet', 'Game', 'Date', 'Clock', 'Score'], w.map(b => [D.c.who(b.pid, b.n), `<span class="big">${b.d ?? '—'}</span>`, `${tlink(b.t)} vs ${tlink(b.o)}`, D.nights.has(b.date) ? nlink(b.date) : esc(fmtShort(b.date)), `<span class="n">${esc(b.q)} ${clock(b.secs)}</span>`, `<span class="meta">${esc(b.sc || '')}</span>`]))}<p class="note">${esc(coverage(D))} Counted: a made shot that takes the lead with 1.0 second or less on the clock in the 4th quarter or overtime.</p></section>`]; },
  qaFn: D => { const w = D.rare.all.filter(isHornWinner), by = {}; w.forEach(b => by[b.s] = (by[b.s] || 0) + 1); const ss = Object.keys(by).filter(s => s !== D.season);
    const avg = ss.length ? Math.round(ss.reduce((n, s) => n + by[s], 0) / ss.length) : 0;
    return [['How rare is a buzzer-beating game-winner?', `About ${avg} a season across the whole NBA, fewer than one per team. ${w.length} since ${D.rare.seasons[0]}, by ${new Set(w.map(b => b.pid)).size} different players.`]]; },
  related: RARE_REL.filter(s => s !== 'buzzer-beating-game-winners') });
rarePage({ slug: 'game-winners', label: 'Game-winners', blurb: 'Most go-ahead shots in the final 30 seconds', title: 'Most Game-Winning Shots in the NBA: Clutch Go-Ahead Leaders Since 1996-97', word: 'go-ahead clutch shot',
  h1: 'Game-<em>winners.</em>', test: isClutch,
  lead: 'Every made shot that put a team ahead in the final 30 seconds of the fourth quarter or overtime, from NBA.com play-by-play since 1996-97. Shots whose lead held to the final horn are tagged GAME-WINNER.',
  extra: D => { const w = D.rare.all.filter(b => isClutch(b) && b.s === D.season).sort((a, b) => b.date.localeCompare(a.date));
    return [`<section><h2>Every clutch go-ahead shot this season</h2>${table(['Player', 'Feet', 'Game', 'Date', 'Clock', 'Tags'], shotRows(D, w), 'None yet this season.')}</section>`]; },
  related: RARE_REL.filter(s => s !== 'game-winners') });
rarePage({ slug: 'logo-threes', label: 'Logo threes', blurb: 'Most made shots from 30+ feet', title: 'Logo Three Leaders: Most 30+ Foot Shots in the NBA Since 1996-97', word: 'logo three',
  h1: 'Logo <em>threes.</em>', test: b => isDeep(b) && validDist(b) && b.d >= 30,
  lead: 'Every made shot from 30 feet or more (logo range, heaves and half-court makes), measured by NBA.com play-by-play since 1996-97: career and single-season leaders and this season\'s deepest makes.',
  extra: D => { const w = D.rare.all.filter(b => b.s === D.season && isDeep(b) && validDist(b)).sort((a, b) => b.d - a.d).slice(0, 25);
    return [`<section><h2>Deepest makes this season</h2>${table(['Player', 'Feet', 'Game', 'Date', 'Clock', 'Tags'], shotRows(D, w), 'None yet this season.')}</section>`]; },
  related: RARE_REL.filter(s => s !== 'logo-threes') });
rarePage({ slug: 'four-point-plays', label: '4-point plays', blurb: 'Most threes with a foul and the free throw', title: 'Most 4-Point Plays in the NBA: Leaders Since 1996-97', word: '4-point play',
  h1: '4-point <em>plays.</em>', test: b => b.tags.includes('4-PT PLAY'),
  lead: 'Every three made while fouled, plus the free throw, from NBA.com play-by-play since 1996-97: career and single-season leaders and this season\'s count.',
  related: RARE_REL.filter(s => s !== 'four-point-plays') });

def('rare', 'longest-shots', 'Longest shots', 'The deepest made shots, half-court and beyond', D => {
  const R = D.rare; if (!R.all.length) return null;
  const { name } = D.c, deep = R.all.filter(validDist).sort((a, b) => b.d - a.d || a.date.localeCompare(b.date));
  const top = deep.slice(0, 50), hc = deep.filter(b => b.d >= 43), now = deep.filter(b => b.s === D.season).slice(0, 15);
  const hcBy = leaders(hc, () => true, 15), t0 = top[0];
  const desc = `The longest made shot in the NBA since 1996-97: ${name(t0.pid, t0.n)}'s ${t0.d}-footer on ${fmtShort(t0.date)}. The 50 deepest makes, every half-court shot leader and this season's longest.`;
  const qa = [['What is the longest made shot in the NBA since 1996-97?', `${t0.d} feet, by ${name(t0.pid, t0.n)} (${t0.t}) against ${t0.o} on ${fmtShort(t0.date)}, as measured in NBA.com play-by-play.`],
    ['Who has made the most half-court shots?', `${andList(ties(hcBy, name))}, with ${hcBy[0].v} makes from 43 feet or more since ${R.seasons[0]}.`]];
  if (now[0]) qa.push(['What is the longest shot made this season?', `${now[0].d} feet, by ${name(now[0].pid, now[0].n)} on ${fmtShort(now[0].date)}.`]);
  return shell({ slug: 'longest-shots', title: 'Longest Made Shots in the NBA Since 1996-97: Half-Court & Full-Court Makes | RimBlaze', desc, crumb: 'Longest shots',
    h1: 'The longest <em>shots.</em>', lead: `The deepest made shots in the NBA regular season, by distance in NBA.com play-by-play since ${R.seasons[0]}, from half-court heaves to full-court throws. ${coverage(D)}`,
    strip: stripOf([['Longest', t0.d + ' ft', `${esc(name(t0.pid, t0.n))} · ${esc(fmtShort(t0.date))}`], ['Half-court makes', num(hc.length), `43+ feet since ${R.seasons[0]}`], ['Most half-court makes', hcBy[0].v, esc(andList(ties(hcBy, name)))], ['Longest this season', now[0] ? now[0].d + ' ft' : '—', now[0] ? esc(name(now[0].pid, now[0].n)) : '']]),
    sections: [`<section><h2>Longest this season (${esc(D.season)})</h2>${table(['Player', 'Feet', 'Game', 'Date', 'Clock', 'Tags'], shotRows(D, now), 'None yet this season.')}</section>`,
      `<section><h2>The 50 longest since ${esc(R.seasons[0])}</h2>${table(['Player', 'Feet', 'Game', 'Date', 'Clock', 'Tags'], shotRows(D, top))}<p class="note">Distances are NBA.com's. A few shot locations in early play-by-play are impossible (a 1,640-foot jumper, 70-footers in mid-quarter) and are left out.</p></section>`,
      `<section><h2>Most half-court makes</h2>${table(['Player', 'Makes', 'Seasons'], hcBy.map(r => [D.c.who(r.pid, r.n), `<span class="big">${r.v}</span>`, `<span class="meta">${esc(r.from)} to ${esc(r.to)}</span>`]))}</section>`],
    qa, related: RARE_REL.filter(s => s !== 'longest-shots'), items: top.map(b => `${name(b.pid, b.n)}: ${b.d} ft, ${fmtShort(b.date)}`) });
});

def('rare', '20-point-quarters', '20-point quarters', 'Most points in a single quarter', D => {
  const Q_FROM = D.rare.qFrom, { name, who } = D.c, Q = D.rare.quarters.filter(q => q.s >= Q_FROM).sort((a, b) => b.qMax - a.qMax || a.date.localeCompare(b.date));
  if (!Q.length) return null;
  const top = Q.slice(0, 50), now = Q.filter(q => q.s === D.season), by = leaders(Q.map(q => ({ ...q, n: '' })), () => true, 15), t0 = top[0];
  const per = p => p <= 4 ? 'Q' + p : p === 5 ? 'OT' : 'OT' + (p - 4);
  const rows = list => list.map(q => [who(q.pid), `<span class="big">${q.qMax}</span>`, `<span class="n">${per(q.period)}</span>`, D.nights.has(q.date) ? nlink(q.date) : esc(fmtShort(q.date))]);
  const desc = `Most points in a quarter since ${Q_FROM}: ${name(t0.pid)}'s ${t0.qMax} on ${fmtShort(t0.date)}. Every 20-point quarter this season, the top 50 quarters and the players with the most.`;
  const qa = [[`What is the most points in one quarter since ${Q_FROM}?`, `${t0.qMax}, by ${name(t0.pid)} in the ${per(t0.period) === 'OT' ? 'overtime' : per(t0.period)} on ${fmtShort(t0.date)}.`],
    ['Who has the most 20-point quarters?', `${andList(ties(by, name))}, with ${by[0].v} since ${Q_FROM}.`]];
  return shell({ slug: '20-point-quarters', title: `Most Points in a Quarter: Every 20-Point Quarter in the NBA Since ${Q_FROM} | RimBlaze`, desc, crumb: '20-point quarters',
    h1: '20-point <em>quarters.</em>', lead: `Every quarter where one player scored 20 or more points in the NBA regular season since ${Q_FROM}, counted from NBA.com play-by-play.`,
    strip: stripOf([['Most in a quarter', t0.qMax, `${esc(name(t0.pid))} · ${esc(fmtShort(t0.date))}`], ['This season', now.length, now.length ? `best: ${now[0].qMax} by ${esc(name(now[0].pid))}` : 'None yet'], ['Most 20-point quarters', by[0].v, esc(andList(ties(by, name)))], ['Since', Q_FROM.slice(2), `${num(Q.length)} quarters`]]),
    sections: [`<section><h2>This season (${esc(D.season)})</h2>${table(['Player', 'Points', 'Quarter', 'Date'], rows(now), 'No 20-point quarters yet this season.')}</section>`,
      `<section><h2>Top 50 quarters since ${Q_FROM}</h2>${table(['Player', 'Points', 'Quarter', 'Date'], rows(top))}<p class="note">Counted from play-by-play.${Q_FROM > FIRST ? ` Seasons before ${Q_FROM} are still being rebuilt from archived play-by-play and are added when they are done.` : ''}</p></section>`,
      `<section><h2>Most 20-point quarters</h2>${table(['Player', 'Quarters'], by.map(r => [who(r.pid), `<span class="big">${r.v}</span>`]))}</section>`],
    qa, related: ['most-points-in-a-game', '50-point-games', '40-point-games', 'buzzer-beaters'], items: top.map(q => `${name(q.pid)}: ${q.qMax} points, ${fmtShort(q.date)}`) });
});

def('career', 'milestone-watch', 'Milestone watch', 'Who reaches the next career milestone', D => {
  const W = D.career?.watch || [], C = D.career?.clubs || []; if (!W.length && !C.length) return null;
  const { who, name } = D.c, w0 = W[0];
  const desc = `Upcoming NBA career milestones: ${W.slice(0, 3).map(w => `${w.name} is ${(w.goal - w.cur).toLocaleString('en-US')} ${w.stat} from ${w.goal.toLocaleString('en-US')}`).join('; ')}. Plus who's next to join the 30,000-point, 10,000-rebound and 100-triple-double clubs.`;
  const qa = W.slice(0, 4).map(w => [`When will ${w.name} reach ${w.goal.toLocaleString('en-US')} career ${w.stat}?`, `He has ${w.cur.toLocaleString('en-US')} and needs ${(w.goal - w.cur).toLocaleString('en-US')} more. At ${w.avg} per game this season, that's about ${w.eta} game${w.eta === 1 ? '' : 's'} away.`]);
  C.filter(c => c.next && c.next !== '—').slice(0, 3).forEach(c => qa.push([`Who is the next active player to reach ${c.club}?`, `${c.next}, ${c.nextNeed.toLocaleString('en-US')} away. Active players already there: ${c.members.length ? andList(c.members) : 'none'}.`]));
  return shell({ slug: 'milestone-watch', title: 'Next NBA Milestones: Who Reaches 30,000 Points, 10,000 Rebounds Next | RimBlaze', desc, crumb: 'Milestone watch',
    h1: 'Milestone <em>watch.</em>', lead: 'Active players closing in on a round-number career total, with how many games away they are at this season\'s pace, and who is next into each career club. Updated after every game night.',
    strip: w0 ? stripOf([['Next up', (w0.goal - w0.cur).toLocaleString('en-US'), `${esc(w0.name)} to ${esc(w0.goal.toLocaleString('en-US'))} ${esc(w0.stat)}`], ['Games away', '~' + w0.eta, 'at this season\'s pace'], ['On watch', W.length, 'milestones within 12 games'], ['Clubs', C.length, 'career clubs tracked']]) : '',
    sections: [`<section><h2>Closing in</h2>${table(['Player', 'Milestone', 'Now', 'Needs', 'Per game', 'Games away'], W.map(w => [who(w.pid, w.name), `${esc(w.goal.toLocaleString('en-US'))} ${esc(w.stat)}`, `<span class="n">${num(w.cur)}</span>`, `<span class="big">${num(w.goal - w.cur)}</span>`, `<span class="n">${w.avg}</span>`, `<span class="n">~${w.eta}</span>`]), 'No milestones within 12 games right now.')}</section>`,
      `<section><h2>Career clubs: active players</h2>${table(['Club', 'Active members', 'Next in', 'Needs'], C.map(c => [`<b>${esc(c.club)}</b>`, c.members.length ? esc(c.members.join(', ')) : '<span class="meta">None</span>', c.nextPid ? who(c.nextPid, c.next) : esc(c.next), `<span class="n">${c.nextNeed != null ? num(c.nextNeed) : '—'}</span>`]))}</section>`],
    qa, related: ['triple-doubles', '50-point-games', 'most-points-in-a-game'], items: W.map(w => `${w.name}: ${w.goal.toLocaleString('en-US')} ${w.stat}`) });
});

// ---------- 5. Hub and render ----------
const GROUPS = [['game', 'Single-game records', 'Since 1996-97, regular season'], ['feat', 'Season & career feats', 'Triple-doubles, 50-point games, streaks'], ['rare', 'Rare buckets', 'From play-by-play since 1996-97'], ['career', 'Milestones', 'Active players chasing career marks']];
function hub(built) {
  const url = SITE + '/records/', title = 'NBA Records: Single-Game, Season & Career Records Since 1996-97 | RimBlaze';
  const desc = 'NBA records from every regular-season game since 1996-97: most points in a game, most triple-doubles in a season, every 50-point game, buzzer-beater and game-winner leaders, the longest shots and the next career milestones.';
  const body = `${EXTRA_CSS}<div class="crumbs"><a href="/">RimBlaze</a> / NBA records</div>
<h1>NBA <em>records.</em></h1>
<p class="lead">${esc(desc)} Updated after every game night.</p>
${GROUPS.map(([g, h, s]) => { const ps = built.filter(p => p.group === g); return ps.length ? `<section><h2>${esc(h)}</h2><p class="meta" style="margin:-6px 0 12px">${esc(s)}</p><div class="hub">${ps.map(p => `<a class="card" href="/records/${p.slug}/"><b>${esc(p.label)}</b><span>${esc(p.headline || p.blurb)}</span></a>`).join('')}</div></section>` : ''; }).join('\n')}
<section><h2>Career totals, all time</h2><div class="rel"><a href="/all-time/">Points leaders</a><a href="/all-time/rebounds/">Rebounds</a><a href="/all-time/assists/">Assists</a><a href="/all-time/threes/">3-pointers</a><a href="/all-time/steals/">Steals</a><a href="/all-time/blocks/">Blocks</a></div></section>`;
  const graph = [{ '@type': 'CollectionPage', '@id': url + '#page', url, name: title, description: desc, isPartOf: { '@id': SITE + '/#site' },
    mainEntity: { '@type': 'ItemList', numberOfItems: built.length, itemListElement: built.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/records/${p.slug}/`, name: p.label })) } },
    crumbsLd([['RimBlaze', SITE + '/'], ['NBA records', url]])];
  return page({ title, desc, url, graph, body, current: 'records' });
}

async function writeIfChanged(file, html) {
  try { if ((await readFile(file, 'utf8')) === html) return false; } catch {}
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, html); return true;
}

// Writes /records/ and every record page the data supports. Returns the URLs written (for the sitemap).
export async function renderRecords({ root, season }) {
  const rec = await readJSON(path.join(root, 'data', 'records.json'));
  season = season || rec?.season || (await readJSON(path.join(root, 'data', 'season.json')))?.season;
  const players = (await readJSON(path.join(root, 'data', 'players.json'), [])) || [];
  const slugs = new Map(players.map(p => [p.id, p.slug]));
  const names = { ...(rec?.names || {}) }; players.forEach(p => { names[p.id] = p.name; });
  const nights = new Set(((await readJSON(path.join(root, 'data', 'live', 'index.json'))) || {}).dates || []);
  const D = { rec, season, nights, rare: await rareData(root, season), career: await readJSON(path.join(root, 'data', 'career.json')), c: ctx(slugs, names) };
  const built = [];
  let changed = 0;
  for (const p of PAGES) {
    let out = null;
    try { out = p.build(D); } catch (e) { console.log(`records ${p.slug}: ${e.message}`); }
    if (!out) continue;
    const m = /<meta name="description" content="([^"]*)"/.exec(out.html);
    built.push({ ...p, url: out.url, headline: m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').split(/\. /)[0] : '' });
    if (await writeIfChanged(path.join(root, 'records', p.slug, 'index.html'), out.html)) changed++;
  }
  if (await writeIfChanged(path.join(root, 'records', 'index.html'), hub(built))) changed++;
  let rl = null; try { rl = await renderRareLeaders({ root, season }); } catch (e) { console.log(`rare leaders page: ${e.message}`); }
  return { urls: [SITE + '/records/', ...built.map(p => p.url), ...(rl ? [rl] : [])], changed, pages: built.length };
}

// ---------- 6. Record book entries for profiles ----------
// pid -> up to 8 [{ href, text, rank }] for every board a player appears on, best rank first.
export async function recordBook(root) {
  const rec = await readJSON(path.join(root, 'data', 'records.json'));
  const season = rec?.season || (await readJSON(path.join(root, 'data', 'season.json')))?.season;
  const R = await rareData(root, season), book = new Map();
  const add = (pid, rank, href, text) => { if (!book.has(pid)) book.set(pid, []); book.get(pid).push({ rank, href, text }); };
  const ord = k => { const s = ['th', 'st', 'nd', 'rd'], v = k % 100; return k + (s[(v - 20) % 10] || s[v] || s[0]); };
  if (rec) {
    for (const [k, word, slug] of GAME_PAGES) {
      const G = rec.games?.[k] || [], rk = ranks(G.map(g => ({ v: g[k] }))), seen = new Set();
      G.forEach((g, i) => { if (rk[i] > 25 || seen.has(g.pid)) return; seen.add(g.pid); add(g.pid, rk[i], `/records/${slug}/`, `${ord(rk[i])} most ${word} in a game since 1996-97 (${g[k]}, ${fmtShort(g.date)})`); });
    }
    for (const f of FEATS) {
      const F = rec.feats?.[f.key], slug = FEAT_PAGES[f.key][0]; if (!F) continue;
      const rc = ranks(F.career), rs = ranks(F.season), seen = new Set();
      F.career.forEach((r, i) => { if (rc[i] <= 25) add(r.pid, rc[i], `/records/${slug}/`, `${ord(rc[i])} in career ${f.many} since 1996-97 (${r.v})`); });
      F.season.forEach((r, i) => { if (rs[i] > 25 || seen.has(r.pid)) return; seen.add(r.pid); add(r.pid, rs[i], `/records/${slug}/`, `${ord(rs[i])} in ${f.many} in a season since 1996-97 (${r.v} in ${r.s})`); });
    }
    for (const st of STREAKS) {
      const S = rec.streaks?.[st.key], slug = STREAK_PAGES[st.key][0]; if (!S) continue;
      const rs = ranks(S.season), seen = new Set();
      S.season.forEach((r, i) => { if (rs[i] > 25 || seen.has(r.pid)) return; seen.add(r.pid); add(r.pid, rs[i], `/records/${slug}/`, `${ord(rs[i])}-longest ${st.label} in a season since 1996-97 (${r.v} games, ${r.s})`); });
    }
  }
  if (R.all.length) for (const [slug, word, test] of [['buzzer-beating-game-winners', 'buzzer-beating game-winners', isHornWinner], ['buzzer-beaters', 'buzzer-beaters', b => b.tags.includes('BUZZER')], ['game-winners', 'clutch go-ahead shots', isClutch],
    ['logo-threes', 'logo threes (30+ ft)', b => isDeep(b) && validDist(b) && b.d >= 30], ['four-point-plays', '4-point plays', b => b.tags.includes('4-PT PLAY')]]) {
    const C = leaders(R.all, test), rc = ranks(C);
    C.forEach((r, i) => add(r.pid, rc[i], `/records/${slug}/`, `${ord(rc[i])} in ${word} since ${R.seasons[0]} (${r.v})`));
  }
  for (const v of book.values()) v.sort((a, b) => a.rank - b.rank);
  return book;
}

// ---------- 7. /all-time/rare-buckets/: top 250 rare bucket leaders, sortable by every category ----------
const RB_COLS = [
  ['rare', 'Rare', 'Rare buckets', () => true],
  ['logo', 'Logo 3s', 'Logo threes, heaves and half-court makes (30+ ft)', isDeep],
  ['buzz', 'Buzzer', 'Buzzer-beaters', b => b.tags.includes('BUZZER')],
  ['go', 'Go-ahead', 'Go-ahead shots in the final 30 seconds', isClutch],
  ['horn', 'Horn GW', 'Buzzer-beating game-winners', isHornWinner],
  ['hc', 'Half-court', 'Half-court makes (43+ ft)', b => validDist(b) && b.d >= 43],
  ['four', '4-pt plays', '4-point plays', b => b.tags.includes('4-PT PLAY')],
  ['deep', 'Deepest', 'Deepest make, in feet', null],
];
function rbTally(list) {
  const by = new Map();
  for (const b of list) {
    const r = by.get(b.pid) || { pid: b.pid, n: b.n, t: b.t, from: b.s, to: b.s, deep: 0 };
    RB_COLS.forEach(([k, , , test]) => { if (test) r[k] = (r[k] || 0) + (test(b) ? 1 : 0); });
    if (validDist(b)) r.deep = Math.max(r.deep, b.d || 0);
    r.t = b.t; r.to = b.s; by.set(b.pid, r);
  }
  const rows = [...by.values()], keep = new Set();
  // everyone in the top 250 of any column, so each sort shows its true top 250
  for (const [k] of RB_COLS) rows.slice().sort((a, b) => (b[k] || 0) - (a[k] || 0) || b.rare - a.rare).slice(0, 250).forEach(r => { if (r[k]) keep.add(r); });
  return [...keep].sort((a, b) => b.rare - a.rare || b.deep - a.deep);
}
export async function renderRareLeaders({ root, season }) {
  const rec = await readJSON(path.join(root, 'data', 'records.json'));
  season = season || rec?.season || (await readJSON(path.join(root, 'data', 'season.json')))?.season;
  const R = await rareData(root, season); if (!R.all.length) return null;
  const players = (await readJSON(path.join(root, 'data', 'players.json'), [])) || [];
  const slugs = new Map(players.map(p => [p.id, p.slug])), names = { ...(rec?.names || {}) }; players.forEach(p => { names[p.id] = p.name; });
  const pack = rows => rows.map(r => [r.pid, names[r.pid] || r.n, r.t, slugs.get(r.pid) || '', r.from, r.to, ...RB_COLS.map(([k]) => r[k] || 0)]);
  const all = rbTally(R.all), cur = rbTally(R.all.filter(b => b.s === season));
  const url = `${SITE}/all-time/rare-buckets/`, since = R.seasons[0];
  const top = all.slice(0, 250), lead = top[0], hornLead = all.slice().sort((a, b) => (b.horn || 0) - (a.horn || 0))[0];
  const title = `NBA Rare Bucket Leaders: Top 250 in Buzzer-Beaters, Logo Threes & Game-Winners Since ${since} | RimBlaze`;
  const desc = `The top 250 players in rare buckets since ${since}: buzzer-beaters, logo threes, go-ahead shots, buzzer-beating game-winners, half-court makes and 4-point plays. ${names[lead.pid] || lead.n} leads with ${lead.rare}. Sort by any category.`;
  const tabs = [['/all-time/rare-buckets/', 'Rare buckets', true], ['/all-time/', 'Points'], ['/all-time/rebounds/', 'Rebounds'], ['/all-time/assists/', 'Assists'], ['/all-time/threes/', 'Threes'], ['/all-time/steals/', 'Steals'], ['/all-time/blocks/', 'Blocks']];
  const who = r => slugs.get(r.pid) ? `<a href="/players/${slugs.get(r.pid)}/#vault"><b>${esc(names[r.pid] || r.n)}</b></a>` : `<b>${esc(names[r.pid] || r.n)}</b>`;
  const rk = ranks(top.map(r => ({ v: r.rare })));
  const rowHtml = top.map((r, i) => `<tr><td class="rk">${rk[i]}</td><td>${who(r)}</td><td class="n">${tlink(r.t)}</td>${RB_COLS.map(([k], j) => `<td class="${j ? 'n' : 'big'}">${k === 'deep' ? (r.deep ? r.deep + ' ft' : '—') : r[k] || 0}</td>`).join('')}</tr>`).join('');
  const css = `<style>
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 10px}.tabs a{font:600 12px "IBM Plex Mono",monospace;letter-spacing:.06em;text-transform:uppercase;padding:9px 13px;border:1px solid var(--line);border-radius:3px;background:var(--surface)}.tabs a[aria-current]{background:var(--leather);border-color:var(--leather);color:#fff}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin:8px 0 12px}.seg2{display:inline-flex;border:1px solid var(--line);border-radius:3px;overflow:hidden}.seg2 button{font:600 12px "IBM Plex Mono",monospace;letter-spacing:.05em;text-transform:uppercase;padding:9px 12px;border:0;background:var(--surface);color:var(--muted);cursor:pointer}.seg2 button[aria-pressed="true"]{background:var(--text);color:var(--bg)}
#q{font:14px Inter,system-ui,sans-serif;padding:9px 12px;border:1px solid var(--line);border-radius:3px;background:var(--surface);color:var(--text);min-width:0;width:220px;max-width:100%}
th button{all:unset;cursor:pointer;display:inline-flex;gap:4px;align-items:center;white-space:nowrap}th button:hover,th button:focus-visible{color:var(--text);text-decoration:underline}th[aria-sort="descending"] button{color:var(--leather)}th[aria-sort="descending"] button::after{content:"▼";font-size:9px}
td.rk{font:600 13px "IBM Plex Mono",monospace;color:var(--muted);width:44px}table{min-width:860px}
</style>`;
  const body = `${css}<div class="crumbs"><a href="/">RimBlaze</a> / <a href="/all-time/">All-time</a> / Rare buckets</div>
<h1>Rare bucket <em>leaders.</em></h1>
<p class="lead">${esc(`The top 250 players in rare buckets since ${since}, from NBA.com play-by-play: buzzer-beaters, logo threes, clutch go-ahead shots, buzzer-beating game-winners, half-court makes and 4-point plays. Click any column to sort it high to low.`)}</p>
<nav class="tabs" aria-label="All-time boards">${tabs.map(([h, l, cur]) => `<a href="${h}"${cur ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>
${stripOf([['Leader', lead.rare, `${esc(names[lead.pid] || lead.n)} · rare buckets`], ['Horn GW leader', hornLead.horn || 0, esc(names[hornLead.pid] || hornLead.n)], ['Tracked', num(R.all.length), `rare buckets since ${esc(since)}`], ['Players', num(new Set(R.all.map(b => b.pid)).size), 'with at least one']])}
<section style="padding-top:18px"><div class="bar"><div class="seg2" role="group" aria-label="Range"><button type="button" data-range="all" aria-pressed="true">Since ${esc(since)}</button><button type="button" data-range="season" aria-pressed="false">${esc(season)}</button></div>
<label class="sr" for="q" style="position:absolute;left:-9999px">Filter by name</label><input id="q" type="search" placeholder="Filter by name" autocomplete="off"></div>
<p class="meta" id="showing">Top 250 by rare buckets since ${esc(since)}</p>
<div class="card tbl"><table><thead><tr><th>#</th><th>Player</th><th>Team</th>${RB_COLS.map(([k, l, t], j) => `<th data-k="${k}"${j ? '' : ' aria-sort="descending"'}><button type="button" title="Sort by ${esc(t.toLowerCase())}">${esc(l)}</button></th>`).join('')}</tr></thead><tbody id="rows">${rowHtml}</tbody></table></div>
<p class="note">${esc(coverage({ rare: R, season }))} Team is the player's most recent team with a rare bucket. Horn GW: a go-ahead make with 1.0 second or less left in the 4th quarter or overtime. See also <a class="cnt" href="/records/buzzer-beating-game-winners/">every buzzer-beating game-winner</a> and <a class="cnt" href="/records/">all NBA records</a>.</p></section>
<script type="application/json" id="rb">${JSON.stringify({ cols: RB_COLS.map(([k]) => k), all: pack(all), season: pack(cur), since, seasonLabel: season }).replace(/</g, '\\u003c')}</script>
<script>
(function(){
  var D=JSON.parse(document.getElementById('rb').textContent),C=D.cols,ST={k:'rare',range:'all',q:''};
  var NAMES={rare:'rare buckets',logo:'logo threes',buzz:'buzzer-beaters',go:'go-ahead shots',horn:'buzzer-beating game-winners',hc:'half-court makes',four:'4-point plays',deep:'deepest make'};
  var TEAMS=${JSON.stringify(Object.fromEntries(Object.keys((await import('./teams.mjs')).TEAMS).map(a => [a, teamSlug(a)])))};
  var esc=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
  function render(){
    var i=C.indexOf(ST.k)+6,rows=(ST.range==='all'?D.all:D.season).slice().sort(function(a,b){return b[i]-a[i]||b[6]-a[6]||String(a[1]).localeCompare(b[1]);});
    rows=rows.filter(function(r){return r[i]>0;}).slice(0,250);
    var rk=[],last=null,n=0;rows.forEach(function(r,j){if(r[i]!==last){n=j+1;last=r[i];}rk.push(n);});
    var q=ST.q.toLowerCase(),shown=rows.map(function(r,j){return [r,rk[j]];}).filter(function(x){return !q||String(x[0][1]).toLowerCase().indexOf(q)>=0;});
    document.getElementById('rows').innerHTML=shown.length?shown.map(function(x){var r=x[0];
      var nm=r[3]?'<a href="/players/'+r[3]+'/#vault"><b>'+esc(r[1])+'</b></a>':'<b>'+esc(r[1])+'</b>';
      var tm=TEAMS[r[2]]?'<a href="/teams/'+TEAMS[r[2]]+'/">'+esc(r[2])+'</a>':esc(r[2]);
      return '<tr><td class="rk">'+x[1]+'</td><td>'+nm+'</td><td class="n">'+tm+'</td>'+C.map(function(k,j){var v=r[j+6];return '<td class="'+(k===ST.k?'big':'n')+'">'+(k==='deep'?(v?v+' ft':'—'):v)+'</td>';}).join('')+'</tr>';
    }).join(''):'<tr><td colspan="'+(C.length+3)+'" class="empty">'+(rows.length?'No player matches “'+esc(ST.q)+'”.':'None yet.')+'</td></tr>';
    document.querySelectorAll('th[data-k]').forEach(function(th){if(th.dataset.k===ST.k)th.setAttribute('aria-sort','descending');else th.removeAttribute('aria-sort');});
    document.getElementById('showing').textContent=(q?shown.length+' of ':'')+'Top '+rows.length+' by '+NAMES[ST.k]+(ST.range==='all'?' since '+D.since:' in '+D.seasonLabel);
  }
  document.querySelector('thead').addEventListener('click',function(e){var th=e.target.closest('th[data-k]');if(!th)return;ST.k=th.dataset.k;try{history.replaceState(null,'','#'+ST.k);}catch(err){}render();});
  document.querySelectorAll('[data-range]').forEach(function(b){b.addEventListener('click',function(){ST.range=b.dataset.range;document.querySelectorAll('[data-range]').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false');});render();});});
  document.getElementById('q').addEventListener('input',function(){ST.q=this.value.trim();render();});
  var h=location.hash.slice(1);if(C.indexOf(h)>=0){ST.k=h;render();}
})();
</script>`;
  const graph = [{ '@type': 'CollectionPage', '@id': url + '#page', url, name: title, description: desc, isPartOf: { '@id': SITE + '/#site' },
    mainEntity: { '@type': 'ItemList', name: 'Rare bucket leaders', numberOfItems: top.length, itemListOrder: 'https://schema.org/ItemListOrderDescending', itemListElement: top.slice(0, 50).map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: `${names[r.pid] || r.n}: ${r.rare} rare buckets`, ...(slugs.get(r.pid) ? { url: `${SITE}/players/${slugs.get(r.pid)}/` } : {}) })) } },
    crumbsLd([['RimBlaze', SITE + '/'], ['All-time leaders', SITE + '/all-time/'], ['Rare buckets', url]])];
  await writeIfChanged(path.join(root, 'all-time', 'rare-buckets', 'index.html'), page({ title, desc, url, graph, body, current: 'all-time' }));
  // the same tallies for the homepage's sortable leaders table
  await writeIfChanged(path.join(root, 'data', 'rare-leaders.json'), JSON.stringify({ cols: RB_COLS.map(([k]) => k), all: pack(all), season: pack(cur), since, seasonLabel: season }));
  return url;
}
