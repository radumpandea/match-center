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

    for item in fixtures:
        if item.get("ready") is not False:
            continue
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
        if pack.get("partial") is not True:
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

        if dt < now:
            continue
        if dt - now <= timedelta(days=3):
            selected.append((dt, slug))

    selected.sort(key=lambda x: x[0])
    return [slug for _, slug in selected[:2]]


def build_prompt(slug: str, pack: dict):
    prompt = f"""
You are the editorial assistant for the Match Center repo.

Task: update the file docs/data/matches/{slug}.json in place.

Requirements:
- Preserve existing squads, coach data, form, standings, H2H, and lineup data unless a value is clearly wrong.
- Keep the file valid against the repo schema.
- Remove the `partial` flag and delete `newsCandidates` arrays.
- Add or improve the following editorial fields only if they are relevant and supported by the current match pack:
  - storyOfTheMatch: 6-10 concise, factual bullets.
  - teams.home.stories[] and teams.away.stories[]: 2-3 short, punchy bars per team.
  - funfact and linkLine for the likely XI / notable players only.
  - coach.career / country / age / tenureFrom if empty and easy to confirm.
  - mercatoIn[] / mercatoOut[] and preseason[] if clearly present.
  - news[]: keep only a few recent, match-relevant items, in Romanian or English, and trim old headlines.
- Do not fabricate statistics or transfer fees.
- If a fact is uncertain, leave it null or as-is rather than guessing.
- Return ONLY valid JSON that matches the existing file schema. No markdown fences.

The current file content is:
{json.dumps(pack, ensure_ascii=False, indent=2)}
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
            },
            "auth": api_key if api_key != "unused" else None,
        }

    return {
        "url": base_url + "/chat/completions",
        "headers": headers,
        "payload": {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
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


def finalize_pack(pack: dict):
    pack.pop("partial", None)
    pack.pop("newsCandidates", None)
    for side in ("home", "away"):
        team = pack.get("teams", {}).get(side)
        if isinstance(team, dict):
            team.pop("newsCandidates", None)
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
        response_text = call_model(build_prompt(slug, pack))
        cleaned = clean_response(response_text)

        try:
            updated = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            fail(f"The model did not return valid JSON for {slug}: {exc}\nRaw content:\n{cleaned[:800]}")

        if not isinstance(updated, dict):
            fail(f"The model response for {slug} was not a JSON object.")

        finalized = finalize_pack(updated)
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
