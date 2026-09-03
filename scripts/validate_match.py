#!/usr/bin/env python3
"""Local convenience mirror of scripts/validate-match.mjs, for machines without Node.

    python scripts/validate_match.py docs/data/matches/l1-e4-toulouse-lille.json
    python scripts/validate_match.py            # validates every file in docs/data/matches/

CI uses the .mjs version; this is only for local checks. Needs `pip install jsonschema`.
"""
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "docs", "data", "schema.json")


def semantic_warnings(d):
    w = []
    for side in ("home", "away"):
        t = d.get("teams", {}).get(side, {})
        xi = t.get("predictedXI") or []
        if len(xi) != 11:
            w.append(f"teams.{side}.predictedXI has {len(xi)} entries, expected 11")
        sq = t.get("squad") or []
        if len(sq) < 16:
            w.append(f"teams.{side}.squad has only {len(sq)} players")
        gk = sum(1 for p in sq if p.get("role") == "GK")
        if gk < 2:
            w.append(f"teams.{side}.squad lists {gk} goalkeeper(s) — verify against the official list")
        nums = [p["number"] for p in sq if p.get("number") is not None]
        dupes = sorted({n for n in nums if nums.count(n) > 1})
        if dupes:
            w.append(f"teams.{side}.squad duplicate shirt numbers: {dupes}")
    if len(d.get("storyOfTheMatch") or []) < 4:
        w.append("storyOfTheMatch has fewer than 4 bullets (aim for 6-10)")
    if not (d.get("sources") or []):
        w.append("sources[] is empty")
    return w


def main():
    try:
        import jsonschema
    except ImportError:
        print("pip install jsonschema  # required for this script", file=sys.stderr)
        return 2

    schema = json.load(open(SCHEMA, encoding="utf-8"))
    files = sys.argv[1:] or glob.glob(os.path.join(ROOT, "docs", "data", "matches", "*.json"))
    if not files:
        print("no files to validate")
        return 0

    ok = True
    validator = jsonschema.Draft7Validator(schema)
    for f in files:
        try:
            data = json.load(open(f, encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"X {f}: cannot read/parse - {e}")
            ok = False
            continue
        errors = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
        if errors:
            ok = False
            print(f"X {f}: schema invalid")
            for e in errors[:50]:
                print(f"  /{'/'.join(map(str, e.path))} {e.message}")
            continue
        warns = semantic_warnings(data)
        if warns:
            print(f"OK {f}  ({len(warns)} warning(s))")
            for wmsg in warns:
                print(f"  ! {wmsg}")
        else:
            print(f"OK {f}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
