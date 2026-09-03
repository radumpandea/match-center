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

## Local preview

```bash
cd docs && python -m http.server 8000
# open http://localhost:8000/match.html?m=l1-e4-toulouse-lille
```

## Secrets (GitHub → Settings → Secrets → Actions)

| Secret | Used by | Notes |
|---|---|---|
| `RAPIDAPI_KEY` | refresh-fixtures.yml | free-api-live-football-data key (same as the `comentarii` repo) |
| `ANTHROPIC_API_KEY` | build-match-data.yml | research run — an Anthropic Console API key |
| `ANTHROPIC_WORKSPACE_ID` | build-match-data.yml | **only if** `ANTHROPIC_API_KEY` is an identity-linked key (error: `anthropic-workspace-id is required`). Value looks like `wrkspc_...`, from the Anthropic Console. Not needed for a plain workspace-scoped key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | build-match-data.yml (alt), claude.yml, claude-code-review.yml | `claude setup-token` output; use instead of `ANTHROPIC_API_KEY` if you have a Claude subscription, and for `@claude` / PR review |

## Status

Option A: single user, no accounts, pre-match only. Live in-match data, accounts, and
cross-device sync are deliberately out of scope for now.
