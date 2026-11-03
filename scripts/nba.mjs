// Small client for NBA.com data. Two sources:
//  - stats.nba.com: season, career, game logs, awards, all-time leaders (needs browser-like headers)
//  - cdn.nba.com: schedule, live play-by-play and box scores (public JSON)
// Requests are throttled and retried so a nightly run is polite and survives the odd timeout.

const STATS = 'https://stats.nba.com/stats/';
const CDN = 'https://cdn.nba.com/static/json/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};
const GAP_MS = +(process.env.RB_GAP_MS || 700);
let last = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, { headers = {}, tries = 4, timeout = 30000 } = {}) {
  for (let i = 1; i <= tries; i++) {
    const wait = last + GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    last = Date.now();
    const c = new AbortController(), t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(url, { headers, signal: c.signal });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries) throw new Error(`${url} failed: ${e.message}`);
      await sleep(1500 * i * i);
    } finally { clearTimeout(t); }
  }
}

export function stats(endpoint, params) {
  const q = new URLSearchParams(params).toString();
  return get(STATS + endpoint + '?' + q, { headers: HEADERS });
}
export const cdn = path => get(CDN + path, { headers: { 'User-Agent': HEADERS['User-Agent'] } });

// stats.nba.com returns {resultSets:[{name, headers, rowSet}]} (or resultSet). Turn a set into objects.
export function rows(json, name) {
  if (!json) return [];
  const sets = json.resultSets || (json.resultSet ? [json.resultSet] : []);
  const set = name ? sets.find(s => s.name === name) : sets[0];
  if (!set) return [];
  return set.rowSet.map(r => Object.fromEntries(set.headers.map((h, i) => [h, r[i]])));
}

// ---- Wikidata: hometown (place of birth), high school and college ----
// NBA.com has no hometown or high school field, so these come from Wikidata, which links
// players to NBA.com through property P3647 (NBA.com player ID).
const WD = 'https://query.wikidata.org/sparql';
const WD_UA = 'RimBlazeBot/1.0 (https://rimblaze.com; stats build)';
const SCHOOL_TYPES = 'wd:Q9826 wd:Q159334'; // high school, secondary school (prep schools are usually tagged with one of these)
const COLLEGE_TYPES = 'wd:Q3918 wd:Q189004 wd:Q38723'; // university, college, higher education institution

function bioQuery(ids) {
  return `SELECT ?nba ?type ?item ?itemLabel ?cityLabel ?stateLabel ?countryLabel ?end WHERE {
  VALUES ?nba { ${ids.map(i => `"${i}"`).join(' ')} }
  ?p wdt:P3647 ?nba.
  {
    BIND("born" AS ?type) ?p wdt:P19 ?item.
    OPTIONAL { ?item wdt:P131* ?state. ?state wdt:P31 wd:Q35657. }
    OPTIONAL { ?item wdt:P17 ?country. }
  } UNION {
    BIND("hs" AS ?type) ?p p:P69 ?st. ?st ps:P69 ?item.
    VALUES ?hsType { ${SCHOOL_TYPES} } ?item wdt:P31/wdt:P279* ?hsType.
    OPTIONAL { ?st pq:P582 ?end. }
    OPTIONAL { ?item wdt:P131 ?city. OPTIONAL { ?city wdt:P131* ?state. ?state wdt:P31 wd:Q35657. } }
    OPTIONAL { ?item wdt:P17 ?country. }
  } UNION {
    BIND("college" AS ?type) ?p p:P69 ?st. ?st ps:P69 ?item.
    VALUES ?cType { ${COLLEGE_TYPES} } ?item wdt:P31/wdt:P279* ?cType.
    OPTIONAL { ?st pq:P582 ?end. }
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}
const place = (city, state, country) => [city, state || (country && country !== 'United States of America' ? country : null)].filter(Boolean).join(', ');

// Returns Map(nbaId -> {hometown, highSchools:[{name, place}], colleges:[name]})
export async function wikidataBios(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const batch = ids.slice(i, i + 80);
    const json = await get(WD + '?format=json&query=' + encodeURIComponent(bioQuery(batch)), { headers: { 'User-Agent': WD_UA, Accept: 'application/sparql-results+json' }, timeout: 60000 });
    for (const b of json?.results?.bindings || []) {
      const id = +b.nba.value, v = k => b[k] ? b[k].value : null;
      const r = out.get(id) || { hometown: null, highSchools: [], colleges: [] };
      if (v('type') === 'born' && !r.hometown) r.hometown = place(v('itemLabel'), v('stateLabel'), v('countryLabel'));
      if (v('type') === 'hs' && !r.highSchools.some(h => h.name === v('itemLabel'))) r.highSchools.push({ name: v('itemLabel'), place: place(v('cityLabel'), v('stateLabel'), v('countryLabel')) || null, end: v('end') });
      if (v('type') === 'college' && !r.colleges.includes(v('itemLabel'))) r.colleges.push(v('itemLabel'));
      out.set(id, r);
    }
  }
  // Drop unlabeled items (Wikidata returns the Q-id when there's no English label) and order schools by when he left.
  for (const r of out.values()) {
    r.highSchools = r.highSchools.filter(h => !/^Q\d+$/.test(h.name)).sort((a, b) => String(a.end || '9999').localeCompare(String(b.end || '9999'))).map(({ name, place }) => ({ name, place }));
    r.colleges = r.colleges.filter(c => !/^Q\d+$/.test(c));
    if (r.hometown && /^Q\d+/.test(r.hometown)) r.hometown = null;
  }
  return out;
}

export function seasonFor(date = new Date()) {
  const y = date.getFullYear(), m = date.getMonth() + 1;
  const start = m >= 9 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
export function seasonList(from, to) {
  const out = []; let y = +from.slice(0, 4); const end = +to.slice(0, 4);
  for (; y <= end; y++) out.push(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  return out;
}
