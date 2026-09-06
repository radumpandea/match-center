# Match Center

An interactive pre-match screen for football commentators, pre-loaded with researched
match intelligence. Static site on GitHub Pages; data fed by three daily GitHub Actions.

Live: https://radumpandea.github.io/match-center/

## How it works

```
refresh-fixtures.yml   →  docs/data/fixtures.json      (deterministic, RapidAPI football feed)
prefetch-preview.yml   →  docs/data/teams/<id>.json    (deterministic squad cache, RapidAPI)
                          docs/data/matches/<slug>.json ("partial": true — factual skeleton)
                          docs/data/previews.json      (slugs that have a partial pack)
build-match-data.yml   →  docs/data/matches/<slug>.json (Claude editorial pass — up to 2
                                                         packs closest to kickoff, Haiku,
                                                         ~12 lookups/match, drops the flag)
docs/index.html        →  fixture list
docs/match.html?m=<slug>  →  the Match Center: pitch + predicted XI, player/coach/referee
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
finished pack (tag "PREGĂTIT" vs "LIVE / MANUAL"). Opening a match without a
`docs/data/matches/<slug>.json` yet, `match.html`:

1. Builds a minimal skeleton from that fixture's `fixtures.json` entry (teams, comp,
   round, kickoff, venue if known) — empty pitch slots, no coach/referee/squad yet.
2. If the fixture has an `eventId` (the football feed's per-match id — see below), tries
   a client-side call to the same football feed for lineups, referee and venue, and fills
   in whatever comes back. A banner under the team names says what happened (live data
   found / empty / no key configured / no event id yet).
3. In parallel it loads the **full squad for both teams** from the feed
   (`football-get-list-player?teamid=`), using the `homeId` / `awayId` that
   `refresh-fixtures.mjs` stores on each `fixtures.json` entry (falling back to a
   name match against `football-get-list-all-team?leagueid=` when those are absent —
   older entries get the ids at the next refresh). Each squad member arrives with shirt
   number, age, nationality (3-letter code), height, detailed position and current-season
   aggregates — goals, assists, yellow/red cards, rating — shown in the player card's
   Profil tab and in the "Lot" panels. Opening a player card also lazy-loads
   `football-get-player-detail?playerid=` for preferred foot and, when present, minutes /
   appearances.
4. Anything still missing is fillable by hand: click any empty pitch slot to **pick the
   player for that position from the loaded squad** (searchable), or expand "Adaugă manual
   un jucător nou" for one not in the feed (number, name, position — added to the squad and
   available as a future substitute); click "+ Adaugă antrenor" / "+ Adaugă arbitru" /
   "+ adaugă stadion" next to the coach cards, referee card, or header meta line. All of it
   saves to `localStorage`, same as notes and substitutions.

Once the real research pack lands (daily, or triggered on demand — see `match-data-json`),
opening the match again uses that instead; nothing manual is lost from local storage, but
the richer prep data takes priority over the skeleton/live/manual layers for any field it has.

### Prefetch tier — `prefetch-preview.yml` + `scripts/prefetch-preview.mjs`

A deterministic step (no AI, no token cost) that runs daily after `refresh-fixtures` and,
for every not-`ready` fixture kicking off in the next 6 days, writes
`docs/data/matches/<slug>.json` marked **`"partial": true`** with the factual skeleton the
football feed can give for free:

- full squad for both teams (shirt number, age, country, height, position, season goals /
  assists / cards / rating) — fetched once per team into `docs/data/teams/<teamId>.json`
  and reused across every fixture that team plays, refreshed when older than 3 days;
- head coach name; injuries → `absences[]`; referee name; venue;
- the confirmed lineup + formation, once the feed publishes it (usually only near kickoff);
- `teams.<side>.newsCandidates[]` — raw dated headlines from Google News RSS (no key, no
  library), for the editorial step to triage and paraphrase into `news[]`;
- **head-to-head** (`h2h.recent[]` + `h2h.summary`), **league-table context**
  (`form.position`, `form.note`, `form.table` = the standings row), and a **OneFootball-style
  form guide** (`form.recent[]` — each side's last ~5 matches, competitive and friendly, with
  scores) from a second RapidAPI source, **soccer-football-info** (free tier ~200 calls/day →
  server-side only, same account key as `RAPIDAPI_KEY`, the account must be subscribed to it).
  It also fills `squad[].career` (a short club history) for the players in each team's most
  recent match lineup, matched to the FotMob squad by name — from soccer-football-info
  `players/view`. (`stats.minutes` / `stats.apps` are in neither feed; the `match-data-json`
  skill adds those for the likely XI from FBref.) Championship ids, standings, H2H, per-team
  match history, recent lineups and player careers are cached in `docs/data/teams/_sfi.json`
  (standings/history 2 days, lineups 7, careers 30, H2H per pair 14) and a per-run call
  budget of 190 guards the quota. This key must NOT go in `docs/app/config.js`.

`match.html` treats a partial file as a rich skeleton: it renders the squads and lets you
pick the XI from them, shows an amber "Date parțiale" banner, and still runs the
client-side live calls for what's missing. `index.html` tags these fixtures "DATE PARȚIALE"
(from `docs/data/previews.json`).

`build-match-data.yml` is the **Level 2 editorial pass**: once a day it takes the **1–2
partial packs closest to kickoff** (within 3 days), runs **Haiku** against the
`match-data-json` skill with a **~12-lookup-per-match budget**, and adds only the editorial
fields Level 1 can't — `storyOfTheMatch` polish + a few researched angles, per-team
`stories`, `funfact` / `linkLine` for the likely XI, `coach.career`, `mercato`,
`stats.minutes` / `stats.apps` from FBref — then triages `newsCandidates` into `news[]`,
removes the `partial` flag, and sets `ready: true`. It does **not** re-research squads,
form or H2H. `workflow_dispatch` takes a `model` input to run a marquee match on Sonnet.
The deterministic `storyOfTheMatch` seeds mean a pack still reads well even if this pass
never runs for it.

This tier needs only the `RAPIDAPI_KEY` repo secret (server-side, in the Action) — it does
**not** need the public key in `docs/app/config.js`.

### Live data (client-side) — read this before touching `docs/app/config.js`

`match.html` can call `free-api-live-football-data` directly from the browser (no backend),
using the per-match `eventId` that `refresh-fixtures.mjs` now stores on each `fixtures.json`
entry. This means the API key has to be **embedded in the public page** —
`docs/app/config.js`, committed to the repo, readable by anyone via view-source or the
browser's network tab. It is not a secret once it's there.

Set it up: open `docs/app/config.js` and replace `REPLACE_WITH_RAPIDAPI_KEY` with the same
value as the `RAPIDAPI_KEY` repo secret, then commit and push. Leave the placeholder in
place to skip live lookups entirely (the skeleton + manual-entry flow still works).

If this public copy is ever scraped and abused, rotate it: generate a new key in the
RapidAPI dashboard, update it in `docs/app/config.js` and in the `RAPIDAPI_KEY` repo secret.

**The exact response shape of these endpoints hasn't been verified against a real API key
yet** — `enrichFromLiveApi()` (lineups/referee/venue), `enrichSquadsFromLiveApi()` (squads,
via `applyLiveSquad` / `mapSquadMember`) and `loadPlayerDetail()` in `docs/app/match.js`
are best-effort parsers with a few fallback shapes. The squad parser is modelled on the
FotMob-style `response.list.squad[].members[]` layout (`shirtNumber`, `age`, `ccode`,
`cname`, `height`, `positionIdsDesc`, `goals`, `assists`, `ycards`, `rcards`, `rating`,
`injury`). Once the key above is live, open a match without a prep pack and check the
banner ("Loturile complete au fost încărcate…") and the "Lot" panels; if a field is wrong,
inspect a real response in the browser's network tab and adjust the mappers named above.

## Local preview

```bash
cd docs && python -m http.server 8000
# open http://localhost:8000/match.html?m=l1-e4-toulouse-lille
```

## Secrets (GitHub → Settings → Secrets → Actions)

| Secret | Used by | Notes |
|---|---|---|
| `RAPIDAPI_KEY` | refresh-fixtures.yml, prefetch-preview.yml | free-api-live-football-data key (same as the `comentarii` repo). Used server-side by both deterministic Actions. A copy of this value also lives **publicly** in `docs/app/config.js` for client-side live lookups — see "Live data" below. |
| `ANTHROPIC_API_KEY` | build-match-data.yml | research run — an Anthropic Console API key. **Preferred**: billed per token, no session cap. A daily unattended run needs this; the subscription token below hits its rolling 5-hour session limit. |
| `ANTHROPIC_WORKSPACE_ID` | build-match-data.yml | **only if** `ANTHROPIC_API_KEY` is an identity-linked key (error: `anthropic-workspace-id is required`). Value looks like `wrkspc_...`, from the Anthropic Console. Not needed for a plain workspace-scoped key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | build-match-data.yml (fallback), claude.yml, claude-code-review.yml | `claude setup-token` output. Only used by build-match-data when `ANTHROPIC_API_KEY` is unset — the Claude subscription's 5-hour session limit makes it unreliable for the cron. Still fine for `@claude` / PR review. |

## Status

Option A: single user, no accounts, pre-match only. Live in-match data, accounts, and
cross-device sync are deliberately out of scope for now.
