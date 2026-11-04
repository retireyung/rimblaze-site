// Game-night pages: /nights/<YYYY-MM-DD>/ for every NBA game night of the season, plus /nights/.
// Fully static HTML (no JavaScript needed): final scores, every big night, every rare bucket and
// the double-doubles, linked to player and team pages. Rewritten only when a night changes.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { feats, featScore, tens } from './feats.mjs';
import { TEAMS, teamSlug } from './teams.mjs';
import { SITE, esc, num, page, featCard, crumbsLd, fmtDay, fmtShort, pl } from './shell.mjs';

const clock = s => s == null ? '' : s < 60 ? `0:${s < 10 ? '0' : ''}${Number(s).toFixed(1)}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const teamLink = abbr => teamSlug(abbr) ? `<a href="/teams/${teamSlug(abbr)}/">${esc(abbr)}</a>` : esc(abbr);
const teamName = abbr => TEAMS[abbr]?.name || abbr;

async function writeIfChanged(file, html) {
  try { if ((await readFile(file, 'utf8')) === html) return false; } catch {}
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, html); return true;
}

function summarize(day) {
  const lines = (day.lines || []).map(l => ({ ...l, date: day.date, feats: feats(l) }));
  const big = lines.filter(l => l.feats.length).sort((a, b) => featScore(b.feats) - featScore(a.feats) || b.P - a.P);
  const dd = lines.filter(l => !l.feats.length && tens(l) === 2).sort((a, b) => b.P - a.P);
  const td = lines.filter(l => tens(l) >= 3).length, p40 = lines.filter(l => l.P >= 40).length;
  const top = lines.slice().sort((a, b) => b.P - a.P)[0];
  return { lines, big, dd, td, p40, top, rare: (day.buckets || []).length, games: (day.games || []).length };
}

function nightPage(day, sum, prev, next, slugs) {
  const url = `${SITE}/nights/${day.date}/`, short = fmtShort(day.date), long = fmtDay(day.date);
  const href = pid => slugs.get(pid) ? `/players/${slugs.get(pid)}/` : null;
  const title = `NBA Big Nights, ${short}: Triple-Doubles, 40-Point Games & Buzzer-Beaters | RimBlaze`;
  const topLine = sum.top ? ` Top scorer: ${sum.top.n} with ${sum.top.P} points, ${sum.top.R} rebounds and ${sum.top.A} assists.` : '';
  const desc = `Every NBA big night from ${long}: ${pl(sum.games, 'game')}, ${pl(sum.td, 'triple-double')}, ${pl(sum.p40, '40-point game')} and ${pl(sum.rare, 'rare bucket')} (buzzer-beaters, logo threes and game-winners).${topLine}`;
  const games = (day.games || []).map(g => {
    const awayWin = g.status === 3 && +g.awayScore > +g.homeScore, homeWin = g.status === 3 && +g.homeScore > +g.awayScore;
    return `<div class="card game"><div class="row${awayWin ? ' win' : ''}"><span>${teamLink(g.away)} <span class="meta">${esc(teamName(g.away))}</span></span><b>${g.awayScore ?? ''}</b></div>
<div class="row${homeWin ? ' win' : ''}"><span>${teamLink(g.home)} <span class="meta">${esc(teamName(g.home))}</span></span><b>${g.homeScore ?? ''}</b></div>
<div class="st">${esc(g.text || (g.status === 3 ? 'Final' : 'In progress'))} · <a href="https://www.nba.com/game/${g.id}" rel="noopener">Box score on NBA.com</a></div></div>`;
  }).join('');
  const bigHtml = sum.big.length ? `<div class="feats">${sum.big.map(l => featCard(l, { playerHref: href(l.pid), teamName: l.t })).join('')}</div>`
    : '<div class="card empty">No triple-doubles, 40-point games or other big nights this night.</div>';
  const rare = (day.buckets || []).slice().sort((a, b) => b.tags.length - a.tags.length || (b.d || 0) - (a.d || 0));
  const rareHtml = rare.length ? `<div class="card tbl"><table><thead><tr><th>Player</th><th>Team</th><th>Shot</th><th>Feet</th><th>When</th><th>Why it counts</th></tr></thead><tbody>${rare.map(b => `<tr>
<td>${href(b.pid) ? `<a href="${href(b.pid)}"><b>${esc(b.n)}</b></a>` : `<b>${esc(b.n)}</b>`}</td><td class="n">${teamLink(b.t)} vs ${teamLink(b.o)}</td><td>${esc(b.shot || '')}</td>
<td class="big">${b.d ?? '—'}</td><td class="n">${esc(b.q)} ${clock(b.secs)}</td><td><div class="badges">${b.tags.map((t, i) => `<span class="badge${i ? ' alt' : ''}">${esc(t)}</span>`).join('')}</div></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="card empty">No rare buckets this night.</div>';
  const ddHtml = sum.dd.length ? `<p class="lead" style="font-size:15px">${sum.dd.map(l => `${href(l.pid) ? `<a href="${href(l.pid)}"><b>${esc(l.n)}</b></a>` : esc(l.n)} (${l.P} pts, ${Math.max(l.R, l.A, l.S, l.B)} ${l.R >= 10 ? 'reb' : l.A >= 10 ? 'ast' : l.B >= 10 ? 'blk' : 'stl'})`).join(', ')}</p>` : '<p class="meta">None beyond the big nights above.</p>';
  const pager = `<div class="pager">${prev ? `<a class="btn" href="/nights/${prev}/">← ${esc(fmtShort(prev))}</a>` : '<span></span>'}<a class="btn" href="/nights/">All game nights</a>${next ? `<a class="btn" href="/nights/${next}/">${esc(fmtShort(next))} →</a>` : '<span></span>'}</div>`;
  const events = (day.games || []).map(g => ({ '@type': 'SportsEvent', name: `${teamName(g.away)} at ${teamName(g.home)}`, sport: 'Basketball', startDate: day.date,
    homeTeam: { '@type': 'SportsTeam', name: teamName(g.home) }, awayTeam: { '@type': 'SportsTeam', name: teamName(g.away) }, url: `https://www.nba.com/game/${g.id}` }));
  const graph = [
    { '@type': 'CollectionPage', '@id': url + '#page', url, name: title, description: desc, datePublished: day.date, isPartOf: { '@id': SITE + '/#site' },
      mainEntity: { '@type': 'ItemList', name: `NBA games on ${long}`, numberOfItems: events.length, itemListElement: events.map((e, i) => ({ '@type': 'ListItem', position: i + 1, item: e })) } },
    crumbsLd([['RimBlaze', SITE + '/'], ['Game nights', SITE + '/nights/'], [short, url]]),
  ];
  const body = `<div class="crumbs"><a href="/">RimBlaze</a> / <a href="/nights/">Game nights</a> / ${esc(short)}</div>
<h1>NBA big nights: <em>${esc(long)}</em></h1>
<p class="lead">${esc(`${pl(sum.games, 'game')}, ${pl(sum.td, 'triple-double')}, ${pl(sum.p40, '40-point game')} and ${pl(sum.rare, 'rare bucket')}.${topLine}`)}${day.anyLive ? ' Games are still in progress; this page updates every 10 minutes.' : ''}</p>
<div class="strip"><div><span class="k">Big nights</span><span class="v">${sum.big.length}</span><span class="s">Triple-doubles, 40-point games, 20-20s and more</span></div>
<div><span class="k">Triple-doubles</span><span class="v">${sum.td}</span><span class="s">${sum.dd.length + sum.big.filter(l => tens(l) === 2).length} more double-doubles</span></div>
<div><span class="k">Rare buckets</span><span class="v">${sum.rare}</span><span class="s">Logo threes, buzzer-beaters, game-winners</span></div>
<div><span class="k">Top scorer</span><span class="v">${sum.top ? sum.top.P : '—'}</span><span class="s">${sum.top ? esc(sum.top.n) + ' · ' + esc(sum.top.t) : ''}</span></div></div>
<section><h2>Final scores</h2><div class="games">${games}</div></section>
<section><h2>Big nights</h2>${bigHtml}</section>
<section><h2>Rare buckets</h2>${rareHtml}</section>
<section><h2>Double-doubles</h2>${ddHtml}</section>
${pager}`;
  return page({ title, desc, url, graph, body, current: 'nights' });
}

function indexPage(days, sums, slugs) {
  const url = SITE + '/nights/', title = 'NBA Game Nights: Every Big Night, Triple-Double & Buzzer-Beater | RimBlaze';
  const desc = `Every NBA game night this season: final scores, triple-doubles, 40-point games and rare buckets like buzzer-beaters and logo threes. ${pl(days.length, 'night')} so far.`;
  const byMonth = {};
  days.slice().reverse().forEach(d => { const m = new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); (byMonth[m] = byMonth[m] || []).push(d); });
  const body = `<div class="crumbs"><a href="/">RimBlaze</a> / Game nights</div>
<h1>Every NBA <em>game night.</em></h1>
<p class="lead">${esc(desc)}</p>
${Object.entries(byMonth).map(([m, ds]) => `<section><h2>${esc(m)}</h2><div class="card tbl"><table><thead><tr><th>Night</th><th>Games</th><th>Triple-doubles</th><th>40-point games</th><th>Rare buckets</th><th>Top scorer</th></tr></thead><tbody>${ds.map(d => {
    const s = sums.get(d.date), href = s.top && slugs.get(s.top.pid);
    return `<tr><td><a href="/nights/${d.date}/"><b>${esc(fmtDay(d.date))}</b></a></td><td class="n">${s.games}</td><td class="n">${s.td}</td><td class="n">${s.p40}</td><td class="n">${s.rare}</td><td>${s.top ? `${href ? `<a href="/players/${href}/">${esc(s.top.n)}</a>` : esc(s.top.n)} <span class="meta">${s.top.P} pts</span>` : '—'}</td></tr>`;
  }).join('')}</tbody></table></div></section>`).join('\n')}`;
  const graph = [{ '@type': 'CollectionPage', '@id': url + '#page', url, name: title, description: desc, isPartOf: { '@id': SITE + '/#site' } }, crumbsLd([['RimBlaze', SITE + '/'], ['Game nights', url]])];
  return page({ title, desc, url, graph, body, current: 'nights' });
}

export async function renderNights({ root, days, players }) {
  const slugs = new Map((players || []).map(p => [p.id, p.slug]));
  days = days.slice().sort((a, b) => a.date.localeCompare(b.date));
  const sums = new Map(days.map(d => [d.date, summarize(d)]));
  let changed = 0;
  for (let i = 0; i < days.length; i++) {
    const html = nightPage(days[i], sums.get(days[i].date), days[i - 1]?.date, days[i + 1]?.date, slugs);
    if (await writeIfChanged(path.join(root, 'nights', days[i].date, 'index.html'), html)) changed++;
  }
  if (await writeIfChanged(path.join(root, 'nights', 'index.html'), indexPage(days, sums, slugs))) changed++;
  return changed;
}
