# RimBlaze

Live NBA tracker for rare buckets (logo threes, buzzer-beaters, go-ahead daggers, and-ones, heaves) and big nights (triple-doubles, 40/50/60-point games, 20-20s, 5x5s and more), with season chases, career milestones and a profile for every active player.

## What's here

| Path | What it is |
| --- | --- |
| `index.html` | Homepage. The live feed and Big Nights (Game tab) read `data/live/`, which the home PC refreshes every 10 minutes (NBA.com doesn't let other websites read its live files from the browser). Season and Career tabs read `data/season.json` and `data/career.json`. |
| `scripts/build-live.mjs` | The live snapshot: tonight's scores, rare buckets and box score lines, one file per game night. |
| `player.html` | Player profile template. Opens any player with `player.html#player-<NBA person id>`; the nightly build also pre-renders `players/<name>-<id>/index.html` for search engines. |
| `scripts/build-stats.mjs` | The stats service: the nightly build that writes everything under `data/` and `players/`. |
| `scripts/pages.mjs` | Builds the search-friendly pages: every profile, six all-time boards (`/all-time/`, `/all-time/rebounds/`, …), the players A–Z directory and `sitemap.xml`, each with its own title, description, share tags and schema.org structured data. |
| `scripts/prerender.mjs` | Runs each page's own script at build time and writes the result into the HTML, so search engines and link previews see the full content without JavaScript. |
| `templates/all-time.html` | Template for the all-time boards. |
| `scripts/nights.mjs` | Game-night pages, `/nights/<date>/` and `/nights/`: scores, big nights, rare buckets and double-doubles. Written by the live snapshot every 10 minutes. |
| `scripts/teamPages.mjs` | Team pages, `/teams/<team>/` and `/teams/`: record, roster, big nights, rare buckets and franchise scoring leaders (including former cities). |
| `scripts/teams.mjs`, `scripts/shell.mjs` | The 30 teams and their past codes; the shared layout for the static pages. |
| `scripts/feats.mjs` | The rules: what counts as a big night, a rare bucket, a badge and a milestone. The pages use the same thresholds. |
| `scripts/nba.mjs` | Throttled, retrying client for stats.nba.com and cdn.nba.com. |
| `.github/workflows/nightly-stats.yml` | Runs the build every night at 4:17 a.m. Eastern and commits the data. |

## Hosting

The site is static and runs on GitHub Pages from the `main` branch root, at **rimblaze.com** (the `CNAME` file sets the domain). Every push, including the nightly data commit, redeploys it within a minute or two.

DNS at Namecheap (Advanced DNS):

| Type | Host | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | retireyung.github.io. |

No wildcard (`*`) records. After DNS resolves, tick **Enforce HTTPS** under the repository's Settings → Pages.

On rimblaze.com the pages never show the fictional sample players: if NBA.com's live data can't be reached, the homepage shows a retry notice and tries again every minute. The samples appear only in previews off the domain.

## Run it

Needs Node 20 or newer. No packages to install.

```bash
node scripts/build-stats.mjs                     # full build
node scripts/build-stats.mjs --players 2544      # one player, quick test
node scripts/build-stats.mjs --skip-pages        # JSON only, no pre-rendered pages
npx serve .                                      # look at the site locally
```

The first run downloads every season's game logs since 1996-97 (30 requests) and every active player's career totals, bio and awards (about 1,500 requests). At the built-in pace of one request every 0.7 s that takes 20 to 30 minutes. Everything that can't change is cached in `data/cache/`, so later nightly runs only fetch the current season and players who just played, which takes a few minutes.

## What the build writes

- `data/season.json`: season feat leaders (triple-doubles, double-doubles, 30- and 40-point games, active double-double streak), three season chases measured against the best single season since 1996-97, rare bucket leaders and team totals.
- `data/career.json`: milestone watch (active players within about 12 games of a round number in points, rebounds, assists, threes, steals, blocks or triple-doubles) and career clubs with the next player in.
- `data/buckets/<season>.json`: every rare bucket of the season, from play-by-play.
- `data/players/<id>.json` and `data/players.json`: one profile per active player, plus the search index.
- `players/<name>-<id>/index.html`: pre-rendered profile pages with the player's data embedded.

## Things to know

- **stats.nba.com blocks cloud servers, including GitHub's.** The nightly build therefore runs on a home Windows PC: `tools/run-nightly.ps1` pulls, builds and pushes, and `tools/setup-windows.ps1` schedules it with Task Scheduler every 10 minutes from noon to 1:30 a.m. (live snapshot every run, full stats every 30 minutes) and at 4:17 a.m., through a hidden launcher (`tools/run-hidden.vbs`). Runs only commit when the stats actually changed, so quiet runs don't redeploy the site. Each run is logged to `data\cache\nightly.log`. `RB_GAP_MS=1200` slows the pace if NBA.com throttles you. The GitHub workflow is kept for manual runs only.
- **Historical profiles:** retired players in the top 250 all-time in points, rebounds or assists get profiles too (`--hist-top 250` changes the cutoff). Their files are cached for 90 days, so they cost nothing on nightly runs.
- **Game-level feats start in 1996-97.** That's where NBA.com's game logs begin. It covers every active player's whole career, so profiles are complete; "most in a season" records in the chases are labeled "since 1996-97".
- **Rare buckets start this season.** They come from play-by-play, which the build scans game by game going forward. Older seasons can be backfilled by pointing `seasonBuckets()` at past schedules.
- **Hometown, high school and college come from Wikidata.** NBA.com has no hometown or high school field (its "last attended" field is used as a fallback when Wikidata lists no college). Wikidata links players through property P3647 (NBA.com player ID) and is refreshed weekly. Hometown is the player's place of birth; for the few players who grew up somewhere else, fix the Wikidata entry or add an override. A player missing from Wikidata simply shows no hometown or high school.
- **Video**: clips link to the game's page on NBA.com. Embedding clips needs a license from the NBA.
- **Alerts**: the email form is a placeholder. It needs an email or push provider before it stores anything.
