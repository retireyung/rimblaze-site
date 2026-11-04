// Live stats relay for homeruns.com and rimblaze.com
// Fetches MLB and NBA feeds once, caches them briefly, and serves every visitor from the cache.
//   /mlb/<path>  -> https://statsapi.mlb.com/api/<path>
//   /nba/<path>  -> https://cdn.nba.com/static/json/<path>
//   /rimblaze/live/<file>.json -> RimBlaze live snapshot written on this server by scripts/build-live.mjs
//   /health      -> status JSON
'use strict';
const http = require('http');
const fs = require('fs');
const pathMod = require('path');
const RB_LIVE_DIR = process.env.RB_LIVE_DIR || '/opt/livestats/rimblaze-live';

const PORT = Number(process.env.PORT || 8080);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://homeruns.com,https://www.homeruns.com,https://rimblaze.com,https://www.rimblaze.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const EXTRA_ORIGIN_SUFFIXES = ['.claude.ai', '.claudeusercontent.com']; // artifact previews

const UPSTREAMS = {
  mlb: process.env.UPSTREAM_MLB || 'https://statsapi.mlb.com/api',
  nba: process.env.UPSTREAM_NBA || 'https://cdn.nba.com/static/json',
};
const UA = 'LiveStatsRelay/1.0';
const MAX_ENTRIES = 3000;
const MAX_BODY = 25 * 1024 * 1024;

// How long (ms) a cached copy counts as fresh, by feed type.
function ttlFor(src, path) {
  if (src === 'nba') {
    if (path.startsWith('/liveData/')) return 5000;          // play-by-play, box scores, scoreboard
    if (path.startsWith('/staticData/')) return 60 * 60e3;   // schedule
    return 60e3;
  }
  // MLB
  if (/\/feed\/live|\/playByPlay|\/linescore|\/boxscore/.test(path)) return 5000;
  if (path.startsWith('/v1/schedule')) return 15e3;
  if (/\/stats|\/standings|\/teams|\/people/.test(path)) return 5 * 60e3;
  return 60e3;
}

const cache = new Map();     // key -> {status, body, type, at, ttl}
const inflight = new Map();  // key -> Promise
const stats = { started: Date.now(), hits: 0, misses: 0, stale: 0, errors: 0 };

function evict() {
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

async function fetchUpstream(src, pathAndQuery) {
  const url = UPSTREAMS[src] + pathAndQuery;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: src === 'nba' ? 'https://www.nba.com/' : undefined },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BODY) throw new Error('upstream body too large');
    return { status: r.status, body: buf, type: r.headers.get('content-type') || 'application/json' };
  } finally { clearTimeout(t); }
}

async function get(src, pathAndQuery, pathOnly) {
  const key = src + pathAndQuery;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) { stats.hits++; return { ...hit, cache: 'HIT' }; }

  if (!inflight.has(key)) {
    inflight.set(key, fetchUpstream(src, pathAndQuery).then(res => {
      if (res.status === 200) {
        const entry = { ...res, at: Date.now(), ttl: ttlFor(src, pathOnly) };
        cache.delete(key); cache.set(key, entry); evict();
      }
      return res;
    }).finally(() => inflight.delete(key)));
  }
  try {
    const res = await inflight.get(key);
    stats.misses++;
    if (res.status !== 200 && hit) { stats.stale++; return { ...hit, cache: 'STALE' }; }
    return { ...res, cache: 'MISS' };
  } catch (e) {
    stats.errors++;
    if (hit) { stats.stale++; return { ...hit, cache: 'STALE' }; }
    return { status: 502, body: Buffer.from(JSON.stringify({ error: 'upstream unavailable' })), type: 'application/json', cache: 'ERROR' };
  }
}

function originAllowed(o) {
  if (!o) return false;
  if (ALLOWED_ORIGINS.includes(o)) return true;
  try { const h = new URL(o).hostname; return EXTRA_ORIGIN_SUFFIXES.some(s => h.endsWith(s)) || h === 'claude.ai'; }
  catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (originAllowed(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET'); res.setHeader('Access-Control-Max-Age', '86400'); res.writeHead(204); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - stats.started) / 1000), cached: cache.size, ...stats }));
  }

  const rb = /^\/rimblaze\/live\/([A-Za-z0-9_\-]+\.json)$/.exec(u.pathname);
  if (rb) {
    const file = pathMod.join(RB_LIVE_DIR, rb[1]);
    return fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"error":"not found"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  const m = /^\/(mlb|nba)(\/[A-Za-z0-9_\-./]*)$/.exec(u.pathname);
  if (!m || m[2].includes('..')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not found"}'); }
  const src = m[1], pathOnly = m[2];
  const out = await get(src, pathOnly + u.search, pathOnly);

  res.writeHead(out.status, {
    'Content-Type': out.type,
    'Cache-Control': out.status === 200 ? 'public, max-age=' + Math.max(1, Math.floor(ttlFor(src, pathOnly) / 1000)) : 'no-store',
    'X-Cache': out.cache,
  });
  res.end(req.method === 'HEAD' ? undefined : out.body);
});

// Keep today's key feeds warm so the first visitor never waits.
function etDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
async function warm() {
  const jobs = [
    ['nba', '/liveData/scoreboard/todaysScoreboard_00.json', '/liveData/scoreboard/todaysScoreboard_00.json'],
    ['mlb', '/v1/schedule?sportId=1&date=' + etDate(), '/v1/schedule'],
  ];
  for (const [src, pq, p] of jobs) { try { await get(src, pq, p); } catch {} }
}
setInterval(warm, 10000);
warm();

server.listen(PORT, '127.0.0.1', () => console.log('live stats relay listening on 127.0.0.1:' + PORT));
