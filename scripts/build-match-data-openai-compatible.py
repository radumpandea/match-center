#!/usr/bin/env python3
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA_DIR = DOCS / "data"
FIXTURES_PATH = DATA_DIR / "fixtures.json"
PREVIEWS_PATH = DATA_DIR / "previews.json"


def fail(message: str):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def choose_matches():
    match_slug = os.environ.get("MATCH", "").strip()
    if match_slug:
        return [match_slug]

    fixtures = read_json(FIXTURES_PATH)
    selected = []
    now = datetime.now(timezone.utc)
    tomorrow = now.date() + timedelta(days=1)

    for item in fixtures:
        slug = item.get("slug")
        if not slug:
            continue
        match_path = DATA_DIR / "matches" / f"{slug}.json"
        if not match_path.exists():
            continue
        try:
            pack = read_json(match_path)
        except json.JSONDecodeError:
            continue
        kickoff = item.get("kickoff") or item.get("date")
        if not kickoff:
            continue
        try:
            if "T" in kickoff:
                dt = datetime.fromisoformat(kickoff.replace("Z", "+00:00"))
            else:
                dt = datetime.strptime(kickoff, "%Y-%m-%d")
                dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue

        if dt.date() == tomorrow:
            selected.append((dt, slug))

    selected.sort(key=lambda x: x[0])
    return [slug for _, slug in selected]


def build_prompt(slug: str, pack: dict):
    editorial_view = {
        "slug": pack.get("slug"),
        "competition": pack.get("competition"),
        "kickoff": pack.get("kickoff"),
        "venue": pack.get("venue"),
        "referee": pack.get("referee"),
        "h2h": pack.get("h2h"),
        "storyOfTheMatch": pack.get("storyOfTheMatch", []),
        "broadcast": pack.get("broadcast"),
        "teams": {},
    }
    for side in ("home", "away"):
        team = pack.get("teams", {}).get(side, {})
        likely_names = {item.get("name") for item in team.get("predictedXI", []) if isinstance(item, dict)}
        likely_players = [
            player for player in team.get("squad", [])
            if isinstance(player, dict) and player.get("name") in likely_names
        ]
        editorial_view["teams"][side] = {
            "name": team.get("name"),
            "coach": team.get("coach"),
            "formation": team.get("formation"),
            "predictedXI": team.get("predictedXI", []),
            "likelyPlayers": likely_players,
            "form": team.get("form"),
            "absences": team.get("absences", []),
            "newsCandidates": team.get("newsCandidates", []),
            "stories": team.get("stories", []),
            "news": team.get("news", []),
            "mercatoIn": team.get("mercatoIn", []),
            "mercatoOut": team.get("mercatoOut", []),
            "preseason": team.get("preseason", []),
        }

    prompt = f"""
Ești editorul sportiv al site-ului Match Center. Scrie toate câmpurile textuale noi în limba română.

Task: produce the Level 2 editorial patch for docs/data/matches/{slug}.json.

Requirements:
- The deterministic Level 1 pack is authoritative. Do not rewrite or return the full match file.
- Return ONLY a small JSON object with these optional keys: `storyOfTheMatch`, `broadcast`, and `teams`.
- Under each team in `teams`, return only these optional keys: `stories`, `news`, `mercatoIn`, `mercatoOut`, `preseason`, `coach`, and `playerEdits`.
- `playerEdits` must be an array of objects with `name` plus only verified text fields among `funfact`, `linkLine`, `pronunciation`, and `statusNote`. Do not edit numeric or enum player fields.
- For `coach`, return only `country`, `age`, `tenureFrom`, and `career` when they are empty or clearly incomplete.
- The patch must preserve the existing squads, coach data, form, standings, H2H, and lineup data.
- Folosește exclusiv fapte prezente explicit în pachetul primit sau în `newsCandidates`. Nu folosi cunoștințe generale neconfirmate și nu completa golurile prin presupuneri.
- Nu transforma un câmp gol, o listă goală sau o formulare vagă într-o afirmație factuală. Dacă nu există dovadă pentru o informație, omite câmpul.
- Nu scrie fraze generice precum „are mai mulți jucători accidentați”, „antrenorul are decizii dificile”, „meciul va fi interesant” sau „echipa caută victoria”. Acestea nu sunt date și trebuie omise.
- Add or improve the following editorial fields only when relevant and supported by the current match pack:
    - storyOfTheMatch: 6-10 bullets concise, factuale, în română; fiecare trebuie să conțină un număr, un nume, o dată, un rezultat, o poziție în clasament sau alt fapt verificabil din pachet.
    - teams.home.stories[] and teams.away.stories[]: 2-3 bare scurte, în română, fiecare bazată pe date concrete din pachet.
  - funfact and linkLine for the likely XI / notable players only.
  - coach.career / country / age / tenureFrom if empty and easy to confirm.
  - mercatoIn[] / mercatoOut[] and preseason[] if clearly present.
    - news[]: păstrează doar câteva știri recente și relevante; reformulează-le în română numai dacă sunt susținute de `newsCandidates` și nu inventa detalii absente din titlu.
- Do not fabricate statistics or transfer fees.
- If a fact is uncertain, leave it null or as-is rather than guessing.
- Each `stories` item MUST be an object with a short `title` and a `bullets` array of 2-5 short strings; never return story strings.
- Keep the patch compact: at most 8 storyOfTheMatch strings, 2 story objects per team, and 3 playerEdits per team.
- Nu returna conținut în engleză pentru `storyOfTheMatch`, `stories`, `news`, `funfact`, `linkLine` sau `statusNote`; numele proprii și denumirile oficiale rămân neschimbate.
- Return ONLY valid JSON for the patch. No markdown fences and no commentary.

The current editorial data is:
{json.dumps(editorial_view, ensure_ascii=False, indent=2)}
"""
    return prompt


def pick_model():
    model = (
        os.environ.get("OPENROUTER_MODEL")
        or os.environ.get("OPENAI_MODEL")
        or os.environ.get("OLLAMA_MODEL")
        or "meta-llama/llama-3.3-70b-instruct"
    )
    return model


def detect_provider():
    if os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_BASE_URL"):
        return "openrouter"
    if os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENAI_BASE_URL"):
        return "openai"
    if os.environ.get("OLLAMA_API_KEY") or os.environ.get("OLLAMA_BASE_URL"):
        return "ollama"
    return "unknown"


def resolve_base_url():
    provider = detect_provider()
    if provider == "openrouter":
        base = os.environ.get("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1"
    elif provider == "openai":
        base = os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1"
    elif provider == "ollama":
        base = os.environ.get("OLLAMA_BASE_URL")
    else:
        base = None

    if not base:
        fail("No model endpoint configured. Set OPENROUTER_BASE_URL, OPENAI_BASE_URL, or OLLAMA_BASE_URL.")
    return base.rstrip("/")


def build_api_call_payload(model: str, prompt: str):
    base_url = resolve_base_url()
    provider = detect_provider()
    api_key = (
        os.environ.get("OPENROUTER_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("OLLAMA_API_KEY")
        or "unused"
    )
    headers = {"Content-Type": "application/json"}
    if provider == "ollama" and api_key and api_key != "unused":
        headers["Authorization"] = f"Bearer {api_key}"
    elif provider in {"openrouter", "openai"} and api_key and api_key != "unused":
        headers["Authorization"] = f"Bearer {api_key}"

    if "/api/chat" in base_url.lower() or "/api/generate" in base_url.lower():
        return {
            "url": base_url,
            "headers": headers,
            "payload": {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "format": "json",
            },
            "auth": api_key if api_key != "unused" else None,
        }

    return {
        "url": base_url + "/chat/completions",
        "headers": headers,
        "payload": {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "max_tokens": 3500,
            "response_format": {"type": "json_object"},
        },
        "auth": None,
    }


def call_model(prompt: str):
    model = pick_model()
    call = build_api_call_payload(model, prompt)
    data = json.dumps(call["payload"]).encode("utf-8")

    req = urllib.request.Request(call["url"], data=data, headers=call["headers"], method="POST")
    if call["auth"]:
        req.add_unredirected_header("Authorization", f"Bearer {call['auth']}")

    context = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(req, timeout=180, context=context) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        provider = detect_provider()
        print(f"Provider: {provider}", file=sys.stderr)
        print(f"Endpoint: {resolve_base_url()}", file=sys.stderr)
        print(f"Model: {pick_model()}", file=sys.stderr)
        print(f"HTTP {exc.code}: {exc.reason}", file=sys.stderr)
        print(body[:1200], file=sys.stderr)
        fail(f"Authentication failed for {provider}. Check the API key and endpoint secret values.")

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, re.DOTALL)
        if match:
            parsed = json.loads(match.group(1))
        else:
            raise

    if "choices" in parsed:
        candidate = parsed["choices"][0].get("message", {}).get("content") or parsed["choices"][0].get("text")
        if isinstance(candidate, list):
            candidate = "".join(part.get("text", "") for part in candidate if isinstance(part, dict))
        if isinstance(candidate, str):
            return candidate

    if "message" in parsed and isinstance(parsed["message"], dict):
        content = parsed["message"].get("content")
        if isinstance(content, str):
            return content

    if "content" in parsed:
        return parsed["content"]

    raise ValueError(f"Unexpected response shape from model: {parsed}")


def clean_response(raw_text: str):
    text = raw_text.strip()
    if text.startswith("```"):
        match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
        if match:
            text = match.group(1)
        else:
            text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
            text = re.sub(r"\s*```$", "", text, flags=re.IGNORECASE)
    return text


def parse_patch_or_retry(slug: str, prompt: str, raw_text: str):
    cleaned = clean_response(raw_text)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        retry_prompt = f"""
Return ONLY a compact valid JSON object for the editorial patch of {slug}.
Do not repeat the match file. Use only these keys: storyOfTheMatch, broadcast, teams.
Each teams.home/away.stories item must be {{"title":"short title","bullets":["short bullet"]}}.
Use at most 6 storyOfTheMatch strings, one story object per team, and no playerEdits.
If you cannot support a value, omit it. No markdown and no commentary.
"""
        retry_text = call_model(retry_prompt)
        retry_cleaned = clean_response(retry_text)
        try:
            parsed = json.loads(retry_cleaned)
        except json.JSONDecodeError as retry_exc:
            fail(
                f"The model did not return valid JSON for {slug} after retry: {retry_exc}\n"
                f"Raw content:\n{retry_cleaned[:1200]}"
            )

    if not isinstance(parsed, dict):
        fail(f"The model response for {slug} was not a JSON patch object.")
    return parsed


def normalize_team_stories(team: dict):
    if not isinstance(team, dict):
        return team

    stories = team.get("stories")
    if stories is None:
        team["stories"] = []
        return team

    if isinstance(stories, dict):
        stories = [stories]

    if not isinstance(stories, list):
        stories = [{"title": "Story", "bullets": [str(stories)]}]

    cleaned = []
    for item in stories:
        if isinstance(item, dict):
            bullets = item.get("bullets")
            if isinstance(bullets, str):
                bullets = [bullets]
            elif not isinstance(bullets, list):
                bullets = []
            cleaned.append({
                "title": item.get("title") or "Story",
                "bullets": [str(b) for b in bullets if b is not None],
            })
        elif isinstance(item, str):
            cleaned.append({"title": "Story", "bullets": [item]})
        elif item is not None:
            cleaned.append({"title": "Story", "bullets": [str(item)]})

    team["stories"] = cleaned
    return team


def normalize_editorial_list(key: str, value):
    if not isinstance(value, list):
        return None

    if key == "news":
        allowed = {"date", "text"}
        required = "text"
    elif key == "mercatoIn":
        allowed = {"name", "from", "fee"}
        required = "name"
    elif key == "mercatoOut":
        allowed = {"name", "to", "fee"}
        required = "name"
    elif key == "preseason":
        allowed = {"opp", "score", "date"}
        required = "opp"
    else:
        return value

    cleaned = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get(required), str):
            continue
        if key == "preseason" and not isinstance(item.get("score"), str):
            continue
        cleaned.append({field: item[field] for field in allowed if field in item})
    return cleaned


def apply_editorial_patch(pack: dict, patch: dict):
    if isinstance(patch.get("storyOfTheMatch"), list):
        pack["storyOfTheMatch"] = [str(item) for item in patch["storyOfTheMatch"] if item is not None]
    if "broadcast" in patch:
        pack["broadcast"] = patch["broadcast"]

    teams_patch = patch.get("teams")
    if not isinstance(teams_patch, dict):
        return pack

    for side in ("home", "away"):
        team = pack.get("teams", {}).get(side)
        changes = teams_patch.get(side)
        if not isinstance(team, dict) or not isinstance(changes, dict):
            continue

        if "stories" in changes and isinstance(changes["stories"], list):
            team["stories"] = changes["stories"]
            normalize_team_stories(team)

        for key in ("news", "mercatoIn", "mercatoOut", "preseason"):
            if key in changes and isinstance(changes[key], list):
                normalized = normalize_editorial_list(key, changes[key])
                if normalized:
                    team[key] = normalized

        coach_patch = changes.get("coach")
        if isinstance(coach_patch, dict) and isinstance(team.get("coach"), dict):
            for key in ("country", "age", "tenureFrom", "career"):
                if key in coach_patch:
                    team["coach"][key] = coach_patch[key]

        player_edits = changes.get("playerEdits")
        if isinstance(player_edits, list):
            by_name = {player.get("name"): player for player in team.get("squad", []) if isinstance(player, dict)}
            allowed = {"funfact", "linkLine", "pronunciation", "statusNote"}
            for edit in player_edits:
                if not isinstance(edit, dict) or edit.get("name") not in by_name:
                    continue
                player = by_name[edit["name"]]
                for key in allowed:
                    if key in edit and (edit[key] is None or isinstance(edit[key], str)):
                        player[key] = edit[key]

    return pack


def finalize_pack(pack: dict):
    pack.pop("partial", None)
    pack.pop("newsCandidates", None)
    for side in ("home", "away"):
        team = pack.get("teams", {}).get(side)
        if isinstance(team, dict):
            team.pop("newsCandidates", None)
            normalize_team_stories(team)
    if "ready" in pack:
        pack["ready"] = True
    return pack


def main():
    targets = choose_matches()
    if not targets:
        print("No eligible partial matches found for the fallback run.")
        return 0

    fixtures = read_json(FIXTURES_PATH)
    fixture_by_slug = {item.get("slug"): item for item in fixtures if item.get("slug")}

    for slug in targets:
        match_path = DATA_DIR / "matches" / f"{slug}.json"
        if not match_path.exists():
            continue

        pack = read_json(match_path)
        prompt = build_prompt(slug, pack)
        response_text = call_model(prompt)
        updated = parse_patch_or_retry(slug, prompt, response_text)

        finalized = finalize_pack(apply_editorial_patch(pack, updated))
        write_json(match_path, finalized)

        if slug in fixture_by_slug:
            fixture_by_slug[slug]["ready"] = True

    write_json(FIXTURES_PATH, fixtures)

    previews = read_json(PREVIEWS_PATH)
    if isinstance(previews, list):
        previews = [item for item in previews if item not in targets]
        write_json(PREVIEWS_PATH, previews)

    for slug in targets:
        match_path = DATA_DIR / "matches" / f"{slug}.json"
        subprocess.run(
            ["node", "scripts/validate-match.mjs", str(match_path.relative_to(ROOT))],
            cwd=str(ROOT),
            check=True,
        )

    print(f"Fallback build completed for: {', '.join(targets)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
