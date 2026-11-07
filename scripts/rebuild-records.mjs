// Rebuilds /records/ from the data already in the repo (no NBA.com calls) and adds its pages to the sitemap.
//   node scripts/rebuild-records.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRecords } from './records.mjs';
import { addToSitemap } from './pages.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = await renderRecords({ root: ROOT });
await addToSitemap(ROOT, r.urls);
console.log(`records: ${r.pages} pages, ${r.changed} changed`);
// the all-time boards share the tab bar with /all-time/rare-buckets/
import { renderAllTime } from './pages.mjs';
const alltime = JSON.parse(await readFile(path.join(ROOT, 'data', 'alltime.json'), 'utf8'));
console.log(`all-time boards: ${await renderAllTime({ root: ROOT, alltime })}`);
