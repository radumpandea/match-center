# Match Center

An interactive pre-match screen for football commentators, pre-loaded with researched
match intelligence. Static site on GitHub Pages; data fed by two daily GitHub Actions.

Live: https://radumpandea.github.io/match-center/

## How it works

```
refresh-fixtures.yml   →  docs/data/fixtures.json      (deterministic, RapidAPI football feed)
build-match-data.yml   →  docs/data/matches/<slug>.json (Claude + .claude/skills/match-data-json)
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
3. Anything still missing is fillable by hand: click any empty pitch slot to add a player
   (number, name, position — they're also added to the squad and become available as a
   future substitute); click "+ Adaugă antrenor" / "+ Adaugă arbitru" / "+ adaugă stadion"
   next to the coach cards, referee card, or header meta line. All of it saves to
   `localStorage`, same as notes and substitutions.

Once the real research pack lands (daily, or triggered on demand — see `match-data-json`),
opening the match again uses that instead; nothing manual is lost from local storage, but
the richer prep data takes priority over the skeleton/live/manual layers for any field it has.

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

**The exact response shape of the lineup/referee/venue endpoints hasn't been verified
against a real API key yet** — `enrichFromLiveApi()` in `docs/app/match.js` is a best-effort
parser with a few fallback shapes. Once the key above is live, open a match without a prep
pack and check whether the banner says "Date live găsite" and the pitch actually fills in;
if not, the field-mapping needs a fix against a real response (inspect it in the browser's
network tab and adjust `applyLiveLineup` / `applyLiveReferee` / `applyLiveLocation`).

## Local preview

```bash
cd docs && python -m http.server 8000
# open http://localhost:8000/match.html?m=l1-e4-toulouse-lille
```

## Secrets (GitHub → Settings → Secrets → Actions)

| Secret | Used by | Notes |
|---|---|---|
| `RAPIDAPI_KEY` | refresh-fixtures.yml | free-api-live-football-data key (same as the `comentarii` repo). A copy of this value also lives **publicly** in `docs/app/config.js` for client-side live lookups — see "Live data" below. |
| `ANTHROPIC_API_KEY` | build-match-data.yml | research run — an Anthropic Console API key. **Preferred**: billed per token, no session cap. A daily unattended run needs this; the subscription token below hits its rolling 5-hour session limit. |
| `ANTHROPIC_WORKSPACE_ID` | build-match-data.yml | **only if** `ANTHROPIC_API_KEY` is an identity-linked key (error: `anthropic-workspace-id is required`). Value looks like `wrkspc_...`, from the Anthropic Console. Not needed for a plain workspace-scoped key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | build-match-data.yml (fallback), claude.yml, claude-code-review.yml | `claude setup-token` output. Only used by build-match-data when `ANTHROPIC_API_KEY` is unset — the Claude subscription's 5-hour session limit makes it unreliable for the cron. Still fine for `@claude` / PR review. |

## Status

Option A: single user, no accounts, pre-match only. Live in-match data, accounts, and
cross-device sync are deliberately out of scope for now.
