// Rebuilds every /players/<slug>/ page from data/players/*.json, without fetching anything.
// Use after changing player.html:  node scripts/rebuild-profiles.mjs
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProfiles } from './pages.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slugify = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const dir = path.join(ROOT, 'data', 'players');
const profiles = [];
for (const f of (await readdir(dir)).filter(f => f.endsWith('.json'))) profiles.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')));
console.log(`rebuilt ${await renderProfiles({ root: ROOT, profiles, slugify })} profile pages`);
