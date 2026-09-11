# Match Center

An interactive pre-match screen for football commentators, pre-loaded with researched
match intelligence. Static site on GitHub Pages; data fed by daily GitHub Actions.
All football data comes from **API-Football** (api-sports.io), used server-side only —
no API key ships in the page.

Live: https://radumpandea.github.io/match-center/

## How it works

```
refresh-fixtures.yml         →  docs/data/fixtures.json      (deterministic, API-Football)
prefetch-preview.yml         →  docs/data/teams/<id>.json    (deterministic squad cache)
                                 docs/data/teams/_afcache.json (standings / stats / h2h / careers)
                                 docs/data/matches/<slug>.json ("partial": true — factual skeleton)
                                 docs/data/previews.json      (slugs that have a partial pack)
build-match-data.yml         →  docs/data/matches/<slug>.json (Claude editorial pass, daily
                                 auto-pick of up to 2, standard depth — Haiku, ~12 lookups)
build-match-data-favourites.yml → the same editorial pass, once per match ANY user has
                                 favourited, at the deep depth (Sonnet, ~50 lookups) — the
                                 shared logic lives in build-match-data-run.yml, called by
                                 both workflows (and by workflow_dispatch for a one-off run)
docs/index.html               →  fixture list — sign in here to see/pick favourites
docs/match.html?m=<slug>      →  the Match Center: pitch + predicted XI, player/coach/referee
                                 cards, story / H2H / form / absences / mercato / news panels,
                                 and a notes layer saved in the browser (localStorage)
```

The match-data JSON contract is `docs/data/schema.json`. Validate a file with:

```bash
npm install
node scripts/validate-match.mjs docs/data/matches/l1-e4-toulouse-lille.json
```

No Node locally? Use the Python mirror (`pip install jsonschema`):

```bash
python scripts/validate_match.py docs/data/matches/l1-e4-toulouse-lille.json
```

## Every fixture opens, even before the daily research pack

`docs/index.html` links every fixture in `fixtures.json`, not just the ones with a
finished pack. `match.html` renders, in priority order:

1. The **partial pack** (`docs/data/matches/<slug>.json` with `"partial": true`) written
   by the daily prefetch — squads with per-player season stats, coach, form, standings,
   head-to-head, injuries, referee and venue. An amber banner marks it.
2. Or, if no pack exists yet, a **bare skeleton** from the `fixtures.json` row (teams,
   comp, round, kickoff, venue if known) — empty pitch, no squads.

There are **no client-side API calls** — the paid API-Football key stays server-side.
Pick each team's **tactical system** from the toolbar first (defaults to whatever the pack's
`formation` says, or 4-4-2) — the pitch reflows to that shape — then anything a pack is
missing is fillable by hand: click any empty pitch slot to pick the player for that position
from the loaded squad (searchable), or expand "Adaugă manual un jucător nou" for one not in
the squad; click "+ Adaugă antrenor" / "+ Adaugă arbitru" / "+ adaugă stadion". All of it
saves to `localStorage`, same as notes and substitutions.

Once the full research pack lands (daily, or on demand — see `match-data-json`), opening
the match again uses that instead; nothing manual is lost from local storage, but the
richer prep data takes priority over the skeleton/manual layers for any field it has.

### Prefetch tier — `prefetch-preview.yml` + `scripts/prefetch-preview.mjs`

A deterministic step (no AI, no token cost) that runs daily after `refresh-fixtures` and,
for every not-`ready` fixture kicking off in the next 6 days, writes
`docs/data/matches/<slug>.json` marked **`"partial": true`** from API-Football:

- **full squad** for both teams — shirt number, age, nationality (3-letter), height,
  weight, primary/observed broad positions, role, and current-season stats **including minutes and appearances** (`players` +
  `players/squads`). Cached per team at `docs/data/teams/<teamId>.json`, reused across
  every fixture that team plays, refreshed after 3 days;
- **coach** — name, age, nationality, full managerial `career[]` and tenure start (`coachs`),
  plus their trophy record (`coach.trophies[]`, competition/season/place from `trophies`);
- **pronostic** → root `predictions`: API-Football's own algorithmic pre-match model
  (`predictions?fixture=`) — win/draw/away percent, an `advice` string, and a
  form/attack/defence/poisson/h2h/goals comparison. Computed by the provider, not written
  by a model, and refetched every run since it updates roughly hourly;
- **injuries / suspensions** → `absences[]`, reason-classified (`injuries`, latest bulletin);
- **referee** + **venue** (name / city / capacity) from `fixtures` + `venues`;
- **confirmed XI**, formation and shirt **colours** once `fixtures/lineups` publishes them
  (usually ~1h before kickoff);
- **weather** → `venue.weather`: temperature, condition, wind, precipitation for the kickoff
  hour, from [Open-Meteo](https://open-meteo.com/) (free, no key) — geocoded from `venue.city`;
- **standings** → `form.table` / `form.position` / `form.last5` / `form.ppg` and a
  home-away split; **form guide** `form.recent[]` (last ~6, this team's perspective);
- **`form.stats`** — Opta-style aggregates from `teams/statistics`: goal-timing split
  (scored and conceded, per 15 min), clean sheets, failed-to-score, penalty share,
  formations used, biggest streak;
- **head-to-head** (`h2h.recent[]` + a W-D-L `h2h.summary`) from `fixtures/headtohead`;
- **`squad[].career`** — a short club-history string per player from `players/teams`;
- `teams.<side>.newsCandidates[]` — raw dated Google News RSS headlines (no key), for the
  editorial step to triage into `news[]`;
- **story seeds** — a few factual `storyOfTheMatch` bullets computed from the numbers above.

Referee, confirmed XI, kit colours, weather and news headlines only become accurate or
available in the final stretch before kickoff, so this script keeps re-checking them **daily,
within 72h of kickoff, even for fixtures already marked `ready`** — the one exception to
"pre-fill only runs before the editorial pass". A fresh `newsCandidates[]` pull is added
alongside any curated `news[]` the editorial pass already wrote (not instead of it) — the
match screen renders both, the raw one flagged as un-triaged.

Standings, team stats, H2H, player careers and coach trophies are cached in
`docs/data/teams/_afcache.json` (2 / 2 / 14 / 30 / 60 days); geocoded venue coordinates are
cached forever. A cold run does ~600 throttled calls; warm runs a fraction of that.
The 7500/day Pro quota is guarded by a per-run budget of 1500 and a 250 ms throttle.

`match.html` renders a partial file as a rich skeleton (squads, form, h2h, amber banner);
`index.html` tags these fixtures "DATE PARȚIALE" (from `docs/data/previews.json`).

`build-match-data.yml` is the **Level 2 editorial pass**, and it has two lanes:

- **`standard`** (the daily cron, and `workflow_dispatch` with `depth: standard`): takes the
  **1–2 partial packs closest to kickoff** (within 3 days, strictly soonest-first), runs
  **Haiku** against the `match-data-json` skill with a **~12-lookup-per-match budget**, and
  adds only the editorial fields Level 1 can't — `storyOfTheMatch` polish + a few researched
  angles, per-team `stories`, `funfact` / `linkLine` for the likely XI, `coach.career`,
  `mercato`, `stats.minutes` / `stats.apps` from FBref — then triages `newsCandidates` into
  `news[]`, removes the `partial` flag, prunes `previews.json`, and sets `ready: true`.
- **`deep`** (`workflow_dispatch` with `depth: deep`, plus a `match:` slug): **one** match,
  **Sonnet**, **~50 lookups**, no field allowlist — the full commentator dossier from the
  skill's "Modul aprofundat" section: rotation-wide player depth (`career` / `funfact` /
  `pronunciation` / `foot` / `height` for the whole realistic rotation, not just the XI),
  Opta-style tactical and statistical angles (set-piece %, goal-timing split, xG vs actual
  from Understat / FBref), 10–14 `storyOfTheMatch` lines, 3–4 `stories` per team, real
  referee averages. For the match you are actually going to commentate.

Both lanes take an optional `match:` slug (operate on exactly that pack instead of the
auto-pick) and a `model:` override. Neither lane re-researches squads, form or H2H. The
deterministic `storyOfTheMatch` seeds mean a pack still reads well even if no editorial pass
runs for it.

Both deterministic Actions need only the `APIFOOTBALL_KEY` repo secret (server-side). No
key is embedded in the page — `docs/app/config.js` is an empty stub and `match.html` makes
no API calls of its own.

## Local preview

```bash
cd docs && python -m http.server 8000
# open http://localhost:8000/match.html?m=l1-e4-toulouse-lille
```

## Secrets (GitHub → Settings → Secrets → Actions)

| Secret | Used by | Notes |
|---|---|---|
| `APIFOOTBALL_KEY` | refresh-fixtures.yml, prefetch-preview.yml | API-Football (api-sports.io) key, Pro plan (7500 req/day). Server-side only — used by both deterministic Actions, never shipped in the page. |
| `CLAUDE_CODE_OAUTH_TOKEN` | build-match-data.yml (**currently preferred**), claude.yml, claude-code-review.yml | `claude setup-token` output — the Claude subscription. No credit cost, but shares one rolling 5-hour session limit with all other Claude usage on that login, so the 06:00 UTC cron can collide with interactive sessions. The build Action prefers this while `ANTHROPIC_API_KEY` is out of credit. |
| `ANTHROPIC_API_KEY` | build-match-data.yml (fallback) | Anthropic Console API key — billed per token, no session cap. Preferred for a daily unattended run **when funded**; it ran dry on 2026-09-05 (`Credit balance is too low`). Used only when `CLAUDE_CODE_OAUTH_TOKEN` is unset. Re-fund it and flip the priority back in `build-match-data.yml`. |
| `ANTHROPIC_WORKSPACE_ID` | build-match-data.yml | **only if** the `ANTHROPIC_API_KEY` fallback is in use AND it is an identity-linked key (error: `anthropic-workspace-id is required`). Value looks like `wrkspc_...`, from the Anthropic Console. Not needed for a plain workspace-scoped key or when running on the OAuth token. |

## Shared edits and favourites (Supabase)

The site still works fully in one browser without an account: edits and favourites
stay in `localStorage`. To make a match screen collaborative across people and
devices, provision a free [Supabase](https://supabase.com/) project once:

1. In **Authentication -> Providers**, make sure **Email** is enabled (it is
   normally enabled by default). Do not enable Anonymous sign-ins for this flow.
2. In **SQL Editor**, run [`docs/supabase.sql`](docs/supabase.sql) — an existing
   project just needs the new bottom half re-run (it's all `create or replace` /
   `drop trigger if exists`, safe to re-run in full).
3. In **Project Settings -> API**, copy the project URL and browser-safe
   **anon/publishable** key into `supabaseUrl` and `supabaseAnonKey` in
   [`docs/app/config.js`](docs/app/config.js), then commit it. Do not use the
   `service_role` key in the browser.

In **Authentication -> URL Configuration**, set the Site URL to
`https://radumpandea.github.io/match-center/` and add that same URL (or the
`https://radumpandea.github.io/match-center/**` wildcard) to Redirect URLs.
Users can sign in right from `docs/index.html` (an email field above the fixture
list) as well as from **Colaborare -> Profil** inside a match screen — either way it's
the same passwordless magic-link email, then choose a display name. The same email
on another device restores that user's favourites and edits. All editor state for a
match syncs to the shared match screen, and the activity tab attributes changes to
that display name.

**Favourites are capped at 4 per user** (enforced by a trigger in `supabase.sql`, not
just the client, so it can't be bypassed). Every match slug favourited by *any* user
is picked up next day by `build-match-data-favourites.yml` and gets the deep
editorial pass — the idea is that favouriting a match is how you tell the pipeline
"I'm commentating this one, give it the full treatment." The Action reads which
slugs are favourited through a `mc_favourite_slugs()` RPC that returns match slugs
only, never who favourited them, so it needs no secret beyond the public anon key
already committed in `config.js`.

## Status

Option A is now a collaborative pre-match tool when Supabase is configured. Live
in-match feed automation is still deliberately out of scope; manual live events,
shared editor changes, favourites and cross-device sync are supported.
