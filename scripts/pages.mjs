// Builds the static, search-friendly pages from the stats:
//   players/<slug>-<id>/index.html   one profile per player (from player.html)
//   all-time/index.html + 5 boards   points, rebounds, assists, threes, steals, blocks (from templates/all-time.html)
//   players/index.html               players A-Z directory
//   sitemap.xml
// Every page gets a specific title and description, share tags, schema.org structured data,
// and its content pre-rendered into the HTML so it can be read without JavaScript.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prerender } from './prerender.mjs';
import { renderTeams } from './teamPages.mjs';
import { TEAMS, teamSlug } from './teams.mjs';

const SITE = 'https://rimblaze.com';
const OG_IMAGE = SITE + '/og-image.png';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const unesc = s => String(s).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const num = v => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const ord = k => { const s = ['th', 'st', 'nd', 'rd'], v = k % 100; return k + (s[(v - 20) % 10] || s[v] || s[0]); };
const ld = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const write = async (rel, html) => { const f = path.join(ROOT_DIR, rel); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, html); };
let ROOT_DIR = '.';

function shareTags({ title, desc, url, type = 'website' }) {
  return [
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="${type}">`, `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`, `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${OG_IMAGE}">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`, `<meta name="twitter:image" content="${OG_IMAGE}">`,
  ].join('\n');
}
const setTitle = (html, t) => html.replace(/<title>[^<]*<\/title>/, `<title>${esc(t)}</title>`);
const setDesc = (html, d) => html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(d)}">`);

// ---------- player pages ----------
const PLAYER_IDS = ['crumbName', 'kicker', 'pName', 'pNick', 'pIntro', 'bio', 'tPts', 'tPtsSub', 'tTd', 'tTdSub', 'tRank', 'tRankSub', 'notice',
  'seasonTitle', 'seasonSub', 'strip', 'vaultSub', 'vaultSum', 'vgrid', 'arcTitle', 'peakNote', 'msTitle', 'msSub', 'ladder', 'recTitle', 'recSub', 'highs',
  'recNights', 'recDeepNote', 'recDeep', 'ybyTitle', 'yby', 'splitsTitle', 'splitsSub', 'splitsCard', 'scoreSub', 'scoreCard', 'nightsTitle', 'nightList',
  'qaSub', 'qa', 'followTitle', 'follow', 'count', 'courtFoot'];

function playerText(p) {
  const n = p.person.name, c = p.career, r = c.ranks || {}, team = p.person.team?.name;
  const td = !p.logsPartial && c.td ? `, ${num(c.td)} triple-doubles` : '';
  const title = `${n} Stats, Career Highs, Triple-Doubles & Milestones | RimBlaze`;
  const desc = p.person.active
    ? `${n}${team ? ` (${team})` : ''} career stats: ${num(c.pts)} points, ${num(c.reb)} rebounds and ${num(c.ast)} assists${td}. Every season, career high, big night, logo three and milestone, updated after every game.`
    : `${n} career stats (${p.person.from}–${p.person.to}): ${num(c.pts)} points${r.pts ? ` (${ord(r.pts)} all-time)` : ''}, ${num(c.reb)} rebounds and ${num(c.ast)} assists. Every season, award, badge and career mark.`;
  return { title, desc };
}
function inches(h) { const m = /(\d+)-(\d+)/.exec(h || ''); return m ? +m[1] * 12 + +m[2] : null; }
function playerLd(p, url, title, qaHtml) {
  const P = p.person, awardsBy = {};
  (p.awards || []).forEach(a => { (awardsBy[a.name] = awardsBy[a.name] || []).push(a.season); });
  const awards = Object.entries(awardsBy).map(([k, v]) => `${k.replace(/^NBA /, '')} (${v.length > 1 ? v.length + '×: ' : ''}${v.join(', ')})`);
  const alumni = [...(P.highSchools || []).map(h => ({ '@type': 'HighSchool', name: h.name })), ...(P.college ? P.college.split(', ').map(c => ({ '@type': 'CollegeOrUniversity', name: c })) : [])];
  const faq = [...String(qaHtml || '').matchAll(/<summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p>/g)].map(m => ({ '@type': 'Question', name: unesc(m[1]), acceptedAnswer: { '@type': 'Answer', text: unesc(m[2]) } }));
  const person = {
    '@type': 'Person', '@id': url + '#person', name: P.name, givenName: P.first, familyName: P.last, url,
    jobTitle: 'Professional basketball player', description: `${P.position || 'NBA'} · ${num(p.career.pts)} career NBA points`,
    sameAs: [`https://www.nba.com/player/${P.id}`],
  };
  if (P.birthDate) person.birthDate = P.birthDate;
  if (P.hometown) person.birthPlace = { '@type': 'Place', name: P.hometown };
  if (inches(P.height)) person.height = { '@type': 'QuantitativeValue', value: inches(P.height), unitCode: 'INH' };
  if (P.weight) person.weight = { '@type': 'QuantitativeValue', value: +P.weight, unitCode: 'LBR' };
  if (P.active && P.team?.name) person.affiliation = { '@type': 'SportsTeam', name: P.team.name, sport: 'Basketball' };
  if ((P.teams || []).length) person.memberOf = P.teams.map(t => ({ '@type': 'SportsTeam', name: t.team, sport: 'Basketball' }));
  if (alumni.length) person.alumniOf = alumni;
  if (awards.length) person.award = awards;
  const graph = [
    { '@type': 'ProfilePage', '@id': url + '#page', url, name: title, ...(p.updated ? { dateModified: p.updated } : {}), mainEntity: { '@id': url + '#person' }, isPartOf: { '@id': SITE + '/#site' }, breadcrumb: { '@id': url + '#crumbs' } },
    person,
    { '@type': 'BreadcrumbList', '@id': url + '#crumbs', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'RimBlaze', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Players', item: SITE + '/players/' },
      { '@type': 'ListItem', position: 3, name: P.name, item: url }] },
  ];
  if (faq.length) graph.push({ '@type': 'FAQPage', '@id': url + '#faq', mainEntity: faq });
  return ld({ '@context': 'https://schema.org', '@graph': graph });
}

async function playerPages(profiles, slugify) {
  const tpl = await readFile(path.join(ROOT_DIR, 'player.html'), 'utf8');
  let done = 0;
  for (const p of profiles) {
    const slug = slugify(p.person.name) + '-' + p.person.id, url = `${SITE}/players/${slug}/`;
    const { title, desc } = playerText(p);
    let html = setDesc(setTitle(tpl, title), desc)
      .replace(/<script type="application\/json" id="rb-sample">[\s\S]*?<\/script>/, '')
      .replace('<!--RB-DATA-->', `<base href="/">\n${shareTags({ title, desc, url, type: 'profile' })}\n<meta name="rb-prod" content="1">\n<script type="application/json" id="rb-data">${JSON.stringify(p).replace(/</g, '\\u003c')}</script>`);
    try {
      const r = await prerender(html, { ids: PLAYER_IDS });
      html = r.html.replace('</title>', `</title>\n${playerLd(p, url, title, r.html)}`); // the quick answers are the only <summary> tags
    } catch (e) { console.log(`prerender ${p.person.name}: ${e.message}`); }
    await write(`players/${slug}/index.html`, html);
    done++;
  }
  return done;
}

// ---------- all-time boards ----------
const BOARD = {
  pts: { slug: '', title: 'NBA All-Time Scoring Leaders: Top 250 Career Points', word: 'points' },
  reb: { slug: 'rebounds/', title: 'NBA All-Time Rebounding Leaders: Top 250 Career Rebounds', word: 'rebounds' },
  ast: { slug: 'assists/', title: 'NBA All-Time Assist Leaders: Top 250 Career Assists', word: 'assists' },
  tpm: { slug: 'threes/', title: 'NBA All-Time 3-Point Leaders: Top 250 Career Threes', word: '3-pointers' },
  stl: { slug: 'steals/', title: 'NBA All-Time Steals Leaders: Top 250 Career Steals', word: 'steals' },
  blk: { slug: 'blocks/', title: 'NBA All-Time Blocks Leaders: Top 250 Career Blocks', word: 'blocks' },
};
async function allTimePages(alltime) {
  const tplFile = path.join(ROOT_DIR, 'templates', 'all-time.html');
  if (!existsSync(tplFile) || !alltime) return 0;
  const tpl = (await readFile(tplFile, 'utf8')).replace(/(href|src)="\.\.\//g, '$1="/');
  let done = 0;
  for (const b of alltime.boards) {
    const meta = BOARD[b.key]; if (!meta) continue;
    const url = `${SITE}/all-time/${meta.slug}`, title = `${meta.title} | RimBlaze`;
    const lead = b.rows[0], act = b.rows.filter(r => r.active)[0];
    const desc = `The top ${alltime.top} in NBA history in career ${meta.word}${lead ? `, led by ${lead.name} with ${num(lead.v)}` : ''}.${act ? ` ${act.name} is the top active player at #${act.rank}.` : ''} Every player links to his full profile; updated after every game.`;
    let html = setDesc(setTitle(tpl, title), desc)
      .replace('<html lang="en">', `<html lang="en" data-board="${b.key}">`)
      .replace(/<link rel="canonical" href="[^"]*">/, '')
      .replace(/<meta property="og:title" content="[^"]*">/, '')
      .replace('</title>', `</title>\n${shareTags({ title, desc, url })}`);
    const list = { '@type': 'ItemList', name: meta.title, numberOfItems: b.rows.length, itemListOrder: 'https://schema.org/ItemListOrderDescending',
      itemListElement: b.rows.map(r => ({ '@type': 'ListItem', position: r.rank, name: `${r.name}: ${num(r.v)} ${meta.word}`, ...(r.slug ? { url: `${SITE}/players/${r.slug}/` } : {}) })) };
    const graph = { '@context': 'https://schema.org', '@graph': [
      { '@type': 'CollectionPage', '@id': url + '#page', url, name: title, description: desc, isPartOf: { '@id': SITE + '/#site' }, mainEntity: list },
      { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'RimBlaze', item: SITE + '/' }, { '@type': 'ListItem', position: 2, name: 'All-time leaders', item: SITE + '/all-time/' }, ...(meta.slug ? [{ '@type': 'ListItem', position: 3, name: b.label, item: url }] : [])] },
    ] };
    try {
      const r = await prerender(html, { ids: ['h1', 'lead', 'notice', 'sum', 'boards', 'showing', 'rows', 'thTot'], fetchMap: { 'alltime.json': alltime } });
      html = r.html;
    } catch (e) { console.log(`prerender all-time ${b.key}: ${e.message}`); }
    html = html.replace('</title>', `</title>\n${ld(graph)}`);
    await write(`all-time/${meta.slug}index.html`, html);
    done++;
  }
  return done;
}

// ---------- players A-Z ----------
async function directory(profiles, slugify) {
  const people = profiles.map(p => ({ name: p.person.name, last: p.person.last || p.person.name.split(' ').pop(), slug: slugify(p.person.name) + '-' + p.person.id,
    note: p.person.active ? (p.person.team?.name || 'Active') : `${p.person.from}–${p.person.to}`, active: p.person.active }))
    .sort((a, b) => a.last.localeCompare(b.last, 'en') || a.name.localeCompare(b.name, 'en'));
  const groups = {};
  people.forEach(p => { const L = (p.last.normalize('NFD')[0] || '#').toUpperCase(); (groups[L] = groups[L] || []).push(p); });
  const letters = Object.keys(groups).sort();
  const title = 'NBA Players A–Z: Stats, Big Nights & Milestones | RimBlaze';
  const desc = `Profiles for ${people.filter(p => p.active).length} active NBA players and ${people.filter(p => !p.active).length} all-time greats: career stats, career highs, triple-doubles, rare buckets, badges and milestones.`;
  const url = SITE + '/players/';
  const body = letters.map(L => `<section class="grp" id="${L === '#' ? 'other' : L}"><h2>${esc(L)}</h2><ul>${groups[L].map(p => `<li><a href="/players/${p.slug}/">${esc(p.name)}</a> <span>${esc(p.note)}</span>${p.active ? ' <i>Active</i>' : ''}</li>`).join('')}</ul></section>`).join('\n');
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${shareTags({ title, desc, url })}
${ld({ '@context': 'https://schema.org', '@graph': [
  { '@type': 'CollectionPage', '@id': url + '#page', url, name: title, description: desc, isPartOf: { '@id': SITE + '/#site' } },
  { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'RimBlaze', item: SITE + '/' }, { '@type': 'ListItem', position: 2, name: 'Players', item: url }] }] })}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#18202F">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,700..900&family=IBM+Plex+Mono:wght@500&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#F5F2EE;--surface:#fff;--line:#DDD3C8;--text:#1C1612;--muted:#6B5D51;--leather:#D9480F}
@media (prefers-color-scheme: dark){:root{--bg:#0E0C0A;--surface:#191512;--line:#382E26;--text:#F2ECE5;--muted:#A99A8C;--leather:#FF7A3D;color-scheme:dark}}
html,body{margin:0}*{box-sizing:border-box}
body{background:var(--bg);color:var(--text);font:16px/1.55 Inter,system-ui,sans-serif}
a{color:inherit;text-decoration:none}
.wrap{max-width:1180px;margin:0 auto;padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}
.top{border-bottom:1px solid var(--line)}.top .wrap{display:flex;align-items:center;justify-content:space-between;height:60px;gap:12px}
.logo{display:flex;align-items:center;gap:10px;font:900 24px Archivo,Impact,sans-serif;font-stretch:78%;text-transform:uppercase}.logo img{width:28px;height:28px}.logo b{color:var(--leather)}
nav{display:flex;gap:20px;font-size:14px;color:var(--muted)}nav a:hover{color:var(--text)}
h1,h2{font-family:Archivo,Impact,sans-serif;font-stretch:80%;font-weight:800;text-transform:uppercase;line-height:1.02;margin:0}
h1{font-size:clamp(2.4rem,8vw,4.6rem);margin:28px 0 12px}h1 em{font-style:normal;color:var(--leather)}
.lead{color:var(--muted);max-width:60ch;margin:0 0 18px}
.letters{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 26px;padding:0;list-style:none}.letters a{display:inline-block;min-width:34px;text-align:center;padding:6px 8px;border:1px solid var(--line);border-radius:3px;background:var(--surface);font:500 12px "IBM Plex Mono",monospace}
.grp{padding:18px 0;border-top:1px solid var(--line)}.grp h2{font-size:28px;color:var(--leather);margin-bottom:10px}
.grp ul{list-style:none;margin:0;padding:0;columns:3 260px;column-gap:28px}.grp li{break-inside:avoid;padding:4px 0;font-size:15px}
.grp li a{font-weight:600}.grp li a:hover{text-decoration:underline}.grp li span{color:var(--muted);font-size:13px}
.grp li i{font-style:normal;font:500 10px "IBM Plex Mono",monospace;color:#fff;background:var(--leather);padding:1px 5px;border-radius:3px;margin-left:4px;vertical-align:1px}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:13px;margin-top:30px}footer .wrap{padding-block:26px 34px}
</style>
<header class="top"><div class="wrap"><a class="logo" href="/"><img src="/favicon.svg" alt="">Rim<b>Blaze</b></a><nav aria-label="Primary"><a href="/">Live</a><a href="/nights/">Game nights</a><a href="/teams/">Teams</a><a href="/all-time/">All-time</a><a href="/players/" aria-current="page">Players</a></nav></div></header>
<main class="wrap">
<h1>NBA players <em>A–Z.</em></h1>
<p class="lead">${esc(desc)}</p>
<ul class="letters">${letters.map(L => `<li><a href="#${L === '#' ? 'other' : L}">${esc(L)}</a></li>`).join('')}</ul>
${body}
</main>
<footer><div class="wrap">© 2026 RimBlaze. <a href="/nights/">Game nights</a> · <a href="/teams/">Teams</a> · <a href="/all-time/">All-time leaders</a> · Stats from NBA.com. Not affiliated with the National Basketball Association.</div></footer>
`;
  await write('players/index.html', html);
  return people.length;
}

// ---------- sitemap ----------
async function sitemap(profiles, slugify, alltime) {
  const today = new Date().toISOString().slice(0, 10);
  let nights = [];
  try { nights = JSON.parse(await readFile(path.join(ROOT_DIR, 'data', 'live', 'index.json'), 'utf8')).dates || []; } catch {}
  const latestNight = nights[nights.length - 1] || today;
  const urls = [[SITE + '/', today, 'hourly', '1.0'], [SITE + '/players/', today, 'daily', '0.8'],
    [SITE + '/nights/', latestNight, 'hourly', '0.8'], ...nights.slice().reverse().map(d => [`${SITE}/nights/${d}/`, d, d === latestNight ? 'hourly' : 'monthly', '0.6']),
    [SITE + '/teams/', today, 'daily', '0.8'], ...Object.keys(TEAMS).map(a => [`${SITE}/teams/${teamSlug(a)}/`, today, 'daily', '0.7']),
    ...(alltime ? Object.values(BOARD).map(b => [`${SITE}/all-time/${b.slug}`, today, 'daily', '0.8']) : []),
    ...profiles.map(p => [`${SITE}/players/${slugify(p.person.name)}-${p.person.id}/`, p.updated || today, p.person.active ? 'daily' : 'monthly', p.person.active ? '0.7' : '0.6'])];
  await writeFile(path.join(ROOT_DIR, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, d, f, pr]) => `  <url><loc>${u}</loc><lastmod>${d}</lastmod><changefreq>${f}</changefreq><priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`);
  return urls.length;
}

export async function renderSite({ root, profiles, alltime, slugify, log, cur = [], buckets = [], season }) {
  ROOT_DIR = root;
  if (!existsSync(path.join(root, 'player.html'))) { log('player.html not found, skipping pages'); return; }
  const n1 = await playerPages(profiles, slugify);
  const n2 = await allTimePages(alltime);
  const n3 = await directory(profiles, slugify);
  const nT = await renderTeams({ root, profiles, cur, buckets, season, slugify });
  const n4 = await sitemap(profiles, slugify, alltime);
  log(`pages: ${n1} profiles, ${n2} all-time boards, directory of ${n3}, ${nT} team pages updated, sitemap of ${n4} URLs`);
}
