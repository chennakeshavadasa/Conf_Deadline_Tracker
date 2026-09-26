#!/usr/bin/env python3
"""Checks tracker/series.yml and docs/data/editions.json. Exits 1 on errors."""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CATEGORIES = {"t1", "ssc", "casf", "cas", "eda"}
CONFIDENCE = {"seed", "official-page", "listing", "web-search", "reviewed", "unverified", "manual"}
REQUIRED_SERIES = ("id", "name", "full", "org", "category", "focus", "url")


def d(s):
    if s is None:
        return None
    if not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        raise ValueError(f"bad date {s!r}")
    return dt.date.fromisoformat(s)


def main() -> int:
    errors, warnings = [], []
    cfg = yaml.safe_load((ROOT / "tracker" / "series.yml").read_text(encoding="utf-8"))
    series = cfg.get("series", [])
    ids = set()
    for s in series:
        for k in REQUIRED_SERIES:
            if not s.get(k):
                errors.append(f"series {s.get('id', '?')}: missing '{k}'")
        if s.get("id") in ids:
            errors.append(f"series id '{s['id']}' is duplicated")
        ids.add(s.get("id"))
        if s.get("id") and not re.fullmatch(r"[a-z0-9]+", s["id"]):
            errors.append(f"series id '{s['id']}' must be lowercase letters/digits")
        if s.get("category") not in CATEGORIES:
            errors.append(f"series {s.get('id')}: category must be one of {sorted(CATEGORIES)}")
        for u in [s.get("url"), s.get("edition_url")] + list(s.get("extra_urls") or []):
            if u and not str(u).startswith(("http://", "https://")):
                errors.append(f"series {s.get('id')}: bad url {u}")

    editions = json.loads((ROOT / "docs" / "data" / "editions.json").read_text(encoding="utf-8"))
    eids = set()
    for e in editions:
        tag = e.get("id", "?")
        if e.get("id") in eids:
            errors.append(f"edition {tag}: duplicated")
        eids.add(e.get("id"))
        if e.get("series") not in ids:
            errors.append(f"edition {tag}: unknown series '{e.get('series')}'")
        if e.get("id") != f"{e.get('series')}-{e.get('year')}":
            errors.append(f"edition {tag}: id must be '<series>-<year>'")
        if e.get("confidence") not in CONFIDENCE:
            errors.append(f"edition {tag}: confidence must be one of {sorted(CONFIDENCE)}")
        try:
            dl, st, en = d(e.get("deadline")), d(e.get("start")), d(e.get("end"))
        except ValueError as exc:
            errors.append(f"edition {tag}: {exc}")
            continue
        if st and st.year != e.get("year"):
            errors.append(f"edition {tag}: start {st} not in year {e.get('year')}")
        if st and en and en < st:
            errors.append(f"edition {tag}: end before start")
        if dl and st and dl >= st:
            errors.append(f"edition {tag}: deadline on/after start")
        if dl and st and (st - dl).days > 430:
            warnings.append(f"edition {tag}: deadline unusually early")

    for w in warnings:
        print("warning:", w)
    for er in errors:
        print("ERROR:", er)
    print(f"Validated {len(series)} series and {len(editions)} editions: {len(errors)} error(s), {len(warnings)} warning(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
