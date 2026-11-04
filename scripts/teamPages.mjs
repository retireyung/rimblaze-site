// Team pages: /teams/<team>/ for all 30 teams, plus /teams/.
// Fully static HTML: this season's record, roster, big nights and rare buckets, and the
// franchise's scoring leaders among RimBlaze profiles (every active player plus the
// all-time top 250), counting the franchise's earlier cities.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { feats, featScore, tens } from './feats.mjs';
import { TEAMS, teamSlug } from './teams.mjs';
import { SITE, esc, num, page, featCard, crumbsLd, fmtShort, pl } from './shell.mjs';

async function writeIfChanged(file, html) {
  try { if ((await readFile(file, 'utf8')) === html) return false; } catch {}
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, html); return true;
}
const per = (a, b) => b ? (a / b).toFixed(1) : '—';
const clock = s => s == null ? '' : s < 60 ? `0:${s < 10 ? '0' : ''}${Number(s).toFixed(1)}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function teamData(abbr, { profiles, cur, buckets, season, slugOf }) {
  const codes = [abbr, ...TEAMS[abbr].past];
  const roster = profiles.filter(p => p.person.active && p.person.team?.abbr === abbr).map(p => ({ p, s: p.seasons.find(x => x.season === season) }))
    .sort((a, b) => (b.s?.pts || 0) - (a.s?.pts || 0));
  const games = new Map(); cur.filter(l => l.t === abbr).forEach(l => games.set(l.gameId, l.wl));
  const w = [...games.values()].filter(x => x === 'W').length, l = [...games.values()].filter(x => x === 'L').length;
  const lines = cur.filter(x => x.t === abbr).map(x => ({ ...x, o: x.o || x.opp, feats: feats(x) }));
  const big = lines.filter(x => x.feats.length).sort((a, b) => b.date.localeCompare(a.date) || featScore(b.feats) - featScore(a.feats));
  const td = lines.filter(x => tens(x) >= 3).length, p40 = lines.filter(x => x.P >= 40).length;
  const rare = buckets.filter(b => b.t === abbr).sort((a, b) => b.tags.length - a.tags.length || (b.d || 0) - (a.d || 0));
  const legends = profiles.map(p => {
    const ss = p.seasons.filter(s => codes.includes(s.team));
    if (!ss.length) return null;
    const pts = ss.reduce((a, s) => a + (s.pts || 0), 0), gp = ss.reduce((a, s) => a + (s.gp || 0), 0);
    const yrs = ss.map(s => +s.season.slice(0, 4));
    return { p, pts, gp, reb: ss.reduce((a, s) => a + (s.reb || 0), 0), ast: ss.reduce((a, s) => a + (s.ast || 0), 0), from: Math.min(...yrs), to: Math.max(...yrs) + 1 };
  }).filter(Boolean).sort((a, b) => b.pts - a.pts).slice(0, 20);
  return { codes, roster, w, l, big, td, p40, rare, legends, slugOf };
}

function teamPage(abbr, d, season) {
  const T = TEAMS[abbr], slug = teamSlug(abbr), url = `${SITE}/teams/${slug}/`;
  const href = p => `/players/${d.slugOf(p)}/`;
  const title = `${T.name} Stats: Rare Buckets, Big Nights, Roster & Franchise Leaders | RimBlaze`;
  const leader = d.legends[0];
  const desc = `${T.name} ${season}: ${d.w}-${d.l}, ${pl(d.big.length, 'big night')} and ${pl(d.rare.length, 'rare bucket')} so far. Roster stats, every triple-double and buzzer-beater, and franchise scoring leaders${leader ? ` led by ${leader.p.person.name} (${num(leader.pts)} points)` : ''}.`;
  const rosterHtml = d.roster.length ? `<div class="card tbl"><table><thead><tr><th>Player</th><th>Pos</th><th>GP</th><th>PPG</th><th>RPG</th><th>APG</th><th>Career pts</th></tr></thead><tbody>${d.roster.map(({ p, s }) => `<tr>
<td><a href="${href(p)}"><b>${esc(p.person.name)}</b></a>${p.person.number ? ` <span class="meta">#${esc(p.person.number)}</span>` : ''}</td><td class="n">${esc(p.person.position || '')}</td><td class="n">${s?.gp ?? 0}</td>
<td class="big">${s ? per(s.pts, s.gp) : '—'}</td><td class="n">${s ? per(s.reb, s.gp) : '—'}</td><td class="n">${s ? per(s.ast, s.gp) : '—'}</td><td class="n">${num(p.career.pts)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="card empty">Roster loads after the next stats run.</div>';
  const bigHtml = d.big.length ? `<div class="feats">${d.big.slice(0, 12).map(l => featCard(l, { playerHref: d.slugOf({ person: { id: l.pid } }) ? `/players/${d.slugOf({ person: { id: l.pid } })}/` : null, nightHref: `/nights/${l.date}/` })).join('')}</div>`
    : '<div class="card empty">No triple-doubles, 40-point games or other big nights yet this season.</div>';
  const rareHtml = d.rare.length ? `<div class="card tbl"><table><thead><tr><th>Player</th><th>Night</th><th>Shot</th><th>Feet</th><th>When</th><th>Why it counts</th></tr></thead><tbody>${d.rare.slice(0, 15).map(b => {
    const ps = d.slugOf({ person: { id: b.pid } });
    return `<tr><td>${ps ? `<a href="/players/${ps}/"><b>${esc(b.n)}</b></a>` : `<b>${esc(b.n)}</b>`}</td><td><a href="/nights/${b.date}/">${esc(fmtShort(b.date))}</a> <span class="meta">vs ${esc(b.o)}</span></td><td>${esc(b.shot || '')}</td>
<td class="big">${b.d ?? '—'}</td><td class="n">${esc(b.q)} ${clock(b.secs)}</td><td><div class="badges">${b.tags.map((t, i) => `<span class="badge${i ? ' alt' : ''}">${esc(t)}</span>`).join('')}</div></td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="card empty">No rare buckets yet this season.</div>';
  const legendsHtml = d.legends.length ? `<div class="card tbl"><table><thead><tr><th>#</th><th>Player</th><th>Years</th><th>GP</th><th>Points</th><th>Rebounds</th><th>Assists</th></tr></thead><tbody>${d.legends.map((x, i) => `<tr>
<td class="n">${i + 1}</td><td><a href="${href(x.p)}"><b>${esc(x.p.person.name)}</b></a>${x.p.person.active ? ' <span class="badge">ACTIVE</span>' : ''}</td><td class="n">${x.from}–${x.p.person.active && x.to > +season.slice(0, 4) ? 'now' : x.to}</td>
<td class="n">${num(x.gp)}</td><td class="big">${num(x.pts)}</td><td class="n">${num(x.reb)}</td><td class="n">${num(x.ast)}</td></tr>`).join('')}</tbody></table></div>
<p class="note">Among players with RimBlaze profiles: every active player plus the top 250 all-time in points, rebounds or assists. Counts regular-season games with the franchise${T.past.length ? `, including its years as ${[...new Set(T.past.map(c => ({ SEA: 'Seattle', NJN: 'New Jersey', NYN: 'New York Nets', CHH: 'the original Hornets', FTW: 'Fort Wayne', SFW: 'San Francisco', PHW: 'Philadelphia', GOS: 'Golden State', SDR: 'San Diego', SDC: 'San Diego', BUF: 'Buffalo', MNL: 'Minneapolis', VAN: 'Vancouver', NOH: 'New Orleans Hornets', NOK: 'New Orleans/Oklahoma City', SYR: 'Syracuse', KCK: 'Kansas City', KCO: 'Kansas City-Omaha', CIN: 'Cincinnati', ROC: 'Rochester', NOJ: 'New Orleans', STL: 'St. Louis', MLH: 'Milwaukee', TRI: 'Tri-Cities', WSB: 'the Bullets', CAP: 'Capital', BAL: 'Baltimore', CHZ: 'Chicago Zephyrs', CHP: 'Chicago Packers' }[c] || c)))].join(', ')}` : ''}. Seasons split between two teams in one year aren't counted.</p>` : '<div class="card empty">No profiled players for this franchise yet.</div>';
  const graph = [
    { '@type': 'WebPage', '@id': url + '#page', url, name: title, description: desc, isPartOf: { '@id': SITE + '/#site' }, about: { '@id': url + '#team' } },
    { '@type': 'SportsTeam', '@id': url + '#team', name: T.name, sport: 'Basketball', url,
      memberOf: { '@type': 'SportsOrganization', name: 'National Basketball Association', url: 'https://www.nba.com/' },
      athlete: d.roster.map(({ p }) => ({ '@type': 'Person', name: p.person.name, url: SITE + href(p) })) },
    crumbsLd([['RimBlaze', SITE + '/'], ['Teams', SITE + '/teams/'], [T.name, url]]),
  ];
  const body = `<div class="crumbs"><a href="/">RimBlaze</a> / <a href="/teams/">Teams</a> / ${esc(T.name)}</div>
<h1>${esc(T.name.replace(/ [^ ]+$/, ''))} <em>${esc(T.name.split(' ').pop())}</em></h1>
<p class="lead">${esc(desc)}</p>
<div class="strip"><div><span class="k">${esc(season)} record</span><span class="v">${d.w}-${d.l}</span><span class="s">${T.conf}ern Conference</span></div>
<div><span class="k">Big nights</span><span class="v">${d.big.length}</span><span class="s">${d.td} triple-double${d.td === 1 ? '' : 's'}, ${d.p40} 40-point game${d.p40 === 1 ? '' : 's'}</span></div>
<div><span class="k">Rare buckets</span><span class="v">${d.rare.length}</span><span class="s">Logo threes, buzzer-beaters, game-winners</span></div>
<div><span class="k">Franchise leader</span><span class="v">${leader ? num(leader.pts) : '—'}</span><span class="s">${leader ? esc(leader.p.person.name) + ' · points' : ''}</span></div></div>
<section><h2>${esc(T.name)} roster</h2>${rosterHtml}</section>
<section><h2>Big nights this season</h2>${bigHtml}</section>
<section><h2>Rare buckets this season</h2>${rareHtml}</section>
<section><h2>Franchise scoring leaders</h2>${legendsHtml}</section>`;
  return page({ title, desc, url, graph, body, current: 'teams' });
}

function indexPage(all, season) {
  const url = SITE + '/teams/', title = 'NBA Teams: Rosters, Big Nights, Rare Buckets & Franchise Leaders | RimBlaze';
  const desc = `All 30 NBA teams: ${season} records, rosters, every big night and buzzer-beater, and each franchise's scoring leaders.`;
  const conf = c => `<section><h2>${c}ern Conference</h2><div class="card tbl"><table><thead><tr><th>Team</th><th>Record</th><th>Big nights</th><th>Rare buckets</th><th>Franchise leader</th></tr></thead><tbody>${all.filter(x => TEAMS[x.abbr].conf === c)
    .sort((a, b) => (b.d.w - b.d.l) - (a.d.w - a.d.l) || TEAMS[a.abbr].name.localeCompare(TEAMS[b.abbr].name)).map(({ abbr, d }) => `<tr>
<td><a href="/teams/${teamSlug(abbr)}/"><b>${esc(TEAMS[abbr].name)}</b></a></td><td class="n">${d.w}-${d.l}</td><td class="n">${d.big.length}</td><td class="n">${d.rare.length}</td>
<td>${d.legends[0] ? `${esc(d.legends[0].p.person.name)} <span class="meta">${num(d.legends[0].pts)} pts</span>` : '—'}</td></tr>`).join('')}</tbody></table></div></section>`;
  const body = `<div class="crumbs"><a href="/">RimBlaze</a> / Teams</div>
<h1>All 30 <em>NBA teams.</em></h1>
<p class="lead">${esc(desc)}</p>
${conf('East')}${conf('West')}`;
  const graph = [{ '@type': 'CollectionPage', '@id': url + '#page', url, name: title, description: desc, isPartOf: { '@id': SITE + '/#site' },
    mainEntity: { '@type': 'ItemList', numberOfItems: 30, itemListElement: Object.keys(TEAMS).map((a, i) => ({ '@type': 'ListItem', position: i + 1, name: TEAMS[a].name, url: `${SITE}/teams/${teamSlug(a)}/` })) } },
    crumbsLd([['RimBlaze', SITE + '/'], ['Teams', url]])];
  return page({ title, desc, url, graph, body, current: 'teams' });
}

export async function renderTeams({ root, profiles, cur, buckets, season, slugify }) {
  const slugOf = p => { const f = profiles.find(x => x.person.id === p.person.id); return f ? slugify(f.person.name) + '-' + f.person.id : null; };
  const all = Object.keys(TEAMS).map(abbr => ({ abbr, d: teamData(abbr, { profiles, cur, buckets, season, slugOf }) }));
  let changed = 0;
  for (const { abbr, d } of all) if (await writeIfChanged(path.join(root, 'teams', teamSlug(abbr), 'index.html'), teamPage(abbr, d, season))) changed++;
  if (await writeIfChanged(path.join(root, 'teams', 'index.html'), indexPage(all, season))) changed++;
  return changed;
}
