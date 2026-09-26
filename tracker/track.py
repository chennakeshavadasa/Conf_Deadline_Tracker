#!/usr/bin/env python3
"""
Conference deadline tracker.

Runs on a schedule (GitHub Actions) and keeps docs/data/*.json up to date:

  1. Roll over: when every tracked edition of a series is over, add next year's.
  2. Pick what is due: near deadlines daily, unannounced every 3 days, the rest weekly.
  3. Fetch official pages and keep only the text that mentions dates.
  4. Ask Claude to extract dates for exactly that edition, with a verbatim quote.
  5. Verify: the quote must appear on the fetched page, and the dates must pass
     sanity rules. Risky changes go to docs/data/review.json instead of the site.
  6. Log every change to docs/data/changelog.json, then rebuild the feeds.

Usage:
  python tracker/track.py                 # normal scheduled run
  python tracker/track.py --all           # check every upcoming edition now
  python tracker/track.py --series iscas  # check one series now
  python tracker/track.py --dry-run       # no API calls, no writes to disk
  python tracker/track.py --accept iscas-2027   # apply pending review items
  python tracker/track.py --reject iscas-2027   # discard pending review items
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
import yaml
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
SERIES_FILE = ROOT / "tracker" / "series.yml"
DATA = ROOT / "docs" / "data"
EDITIONS_FILE = DATA / "editions.json"
CHANGELOG_FILE = DATA / "changelog.json"
REVIEW_FILE = DATA / "review.json"
META_FILE = DATA / "meta.json"
SERIES_JSON = DATA / "series.json"
REVIEW_MD = ROOT / "review-issue.md"   # read by the workflow to open an issue

API_URL = "https://api.anthropic.com/v1/messages"
MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MAX_CHECKS = int(os.environ.get("MAX_CHECKS", "25"))
ALLOW_WEB_SEARCH = os.environ.get("ALLOW_WEB_SEARCH", "1") == "1"

TODAY = dt.date.today()
NOW = dt.datetime.now(dt.timezone.utc)
UA = "Mozilla/5.0 (compatible; conference-deadline-tracker/1.0)"

# Schedule (days between checks)
NEAR_DEADLINE_DAYS = 30
EVERY_NEAR = 1
EVERY_TBA = 3
EVERY_OPEN = 7
EVERY_CLOSED = 14

# Change thresholds
MAX_AUTO_EXTENSION_DAYS = 45   # later deadline within this -> logged as extension
MAX_AUTO_DATE_SHIFT = 3        # conference date moves more than this -> review

MONTHS = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
DATEISH = re.compile(rf"\b{MONTHS}\b|\b20\d\d[-/.]\d{{1,2}}[-/.]\d{{1,2}}\b|\b\d{{1,2}}[-/.]\d{{1,2}}[-/.]20\d\d\b", re.I)
KEYWORDS = re.compile(r"deadline|submission|submit|due|important dates|call for papers|cfp|notification|"
                      r"camera|venue|held|location|hotel|conference|symposium|extended", re.I)


# ---------------------------------------------------------------- utilities
def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def pdate(s) -> dt.date | None:
    if not s or not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return None
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        return None


def pdatetime(s) -> dt.datetime | None:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def log(msg: str) -> None:
    print(msg, flush=True)


def load_series() -> tuple[list[dict], list[dict]]:
    cfg = yaml.safe_load(SERIES_FILE.read_text(encoding="utf-8"))
    return cfg["series"], cfg.get("shared_sources", [])


# ---------------------------------------------------------------- edition state
def is_held(e: dict) -> bool:
    end = pdate(e.get("end")) or pdate(e.get("start"))
    if end:
        return end < TODAY
    return e["year"] < TODAY.year


def deadline_status(e: dict) -> str:
    d = pdate(e.get("deadline"))
    if not d:
        return "tba"
    return "closed" if d < TODAY else "open"


def check_interval(e: dict) -> int:
    d = pdate(e.get("deadline"))
    if d is None:
        return EVERY_TBA
    if d < TODAY:
        return EVERY_CLOSED
    if (d - TODAY).days <= NEAR_DEADLINE_DAYS:
        return EVERY_NEAR
    return EVERY_OPEN


def is_due(e: dict) -> bool:
    if is_held(e):
        return False
    last = pdatetime(e.get("last_checked"))
    if last is None:
        return True
    return (NOW - last).total_seconds() >= check_interval(e) * 86400 - 3600


def priority(e: dict) -> tuple:
    d = pdate(e.get("deadline"))
    st = deadline_status(e)
    rank = {"open": 0, "tba": 1, "closed": 2}[st]
    return (rank, d or dt.date.max, e["id"])


def rollover(series: list[dict], editions: list[dict], changes: list[dict]) -> None:
    """Add next year's edition for any series whose editions are all over."""
    for s in series:
        eds = [e for e in editions if e["series"] == s["id"]]
        if eds and not all(is_held(e) for e in eds):
            continue
        year = max((e["year"] for e in eds), default=TODAY.year - 1) + 1
        if not eds:
            year = TODAY.year
        eid = f"{s['id']}-{year}"
        if any(e["id"] == eid for e in editions):
            continue
        url = s.get("edition_url", s["url"]).replace("{year}", str(year))
        editions.append({
            "id": eid, "series": s["id"], "year": year, "name": f"{s['name']} {year}",
            "start": None, "end": None, "location": None, "deadline": None, "deadline_tz": None,
            "note": None, "url": url, "source": None, "confidence": "unverified",
            "last_checked": None, "last_changed": TODAY.isoformat(), "pinned": [],
        })
        changes.append(change(eid, "new-edition", None, None, None,
                              f"Now tracking {s['name']} {year}. Dates will appear once announced."))
        log(f"  + rolled over to {eid}")


def change(eid, kind, field, old, new, message, source=None) -> dict:
    return {"date": TODAY.isoformat(), "edition": eid, "kind": kind, "field": field,
            "old": old, "new": new, "message": message, "source": source}


# ---------------------------------------------------------------- fetching
_page_cache: dict[str, str | None] = {}


def fetch_text(url: str) -> str | None:
    if url in _page_cache:
        return _page_cache[url]
    text = None
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=25, allow_redirects=True)
        ctype = r.headers.get("content-type", "")
        if r.status_code == 200 and "html" in ctype:
            soup = BeautifulSoup(r.text, "html.parser")
            for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
                tag.decompose()
            lines = [re.sub(r"\s+", " ", ln).strip() for ln in soup.get_text("\n").split("\n")]
            text = "\n".join(ln for ln in lines if ln)
        else:
            log(f"    fetch {url}: HTTP {r.status_code} {ctype[:30]}")
    except requests.RequestException as exc:
        log(f"    fetch {url}: {exc.__class__.__name__}")
    _page_cache[url] = text
    return text


def date_snippets(text: str, limit: int = 9000) -> str:
    """Keep only lines that look like they carry dates, plus one line of context."""
    lines = text.split("\n")
    keep = set()
    for i, ln in enumerate(lines):
        if DATEISH.search(ln) and (KEYWORDS.search(ln) or re.search(r"20\d\d", ln)):
            keep.update({i - 1, i, i + 1})
        elif KEYWORDS.search(ln) and len(ln) < 120:
            keep.add(i)
    out = "\n".join(lines[i] for i in sorted(k for k in keep if 0 <= k < len(lines)))
    return out[:limit]


def name_windows(text: str, names: list[str], width: int = 500, limit: int = 3000) -> str:
    """For listing pages: keep only text near the conference name."""
    chunks = []
    for n in names:
        for m in re.finditer(re.escape(n), text, re.I):
            chunks.append(text[max(0, m.start() - 150): m.end() + width])
    return "\n...\n".join(dict.fromkeys(chunks))[:limit]


def gather_pages(s: dict, e: dict, shared: list[dict]) -> list[dict]:
    year = str(e["year"])
    urls = [e.get("url"), s.get("edition_url", "").replace("{year}", year) or None, s["url"]]
    urls += [u.replace("{year}", year) for u in s.get("extra_urls", [])]
    pages, seen = [], set()
    for u in urls:
        if not u or u in seen:
            continue
        seen.add(u)
        t = fetch_text(u)
        if t:
            snip = date_snippets(t)
            if snip:
                pages.append({"url": u, "official": True, "text": snip})
        if len(pages) >= 3:
            break
    names = [f"{s['name']} {year}", f"{s['name']}{year}"]
    for src in shared:
        if s["category"] not in src.get("applies_to", []):
            continue
        t = fetch_text(src["url"])
        if t:
            win = name_windows(t, names)
            if win:
                pages.append({"url": src["url"], "official": bool(src.get("official")), "text": win})
    return pages


# ---------------------------------------------------------------- extraction
PROMPT = """You extract conference dates for a deadline tracker used by students.

Conference: {name} ({full})
Edition year: {year}
Currently listed: deadline={deadline}, start={start}, end={end}, location={location}
Today: {today}

{material}

Task: report information for EXACTLY the {year} edition. Ignore other years.
- paper_deadline: the regular full-paper submission deadline. If it was extended, give the latest extended date. Not abstract registration, not camera-ready, not special sessions.
- deadline_evidence: copy the exact words (max 25 words) from the provided page text that state the deadline. Must be verbatim. If you used web search instead, quote the search result.
- dates_evidence: same, for the conference dates.
- Use null for anything not officially announced. Never guess from previous years.

Respond with ONLY this JSON, no other text:
{{"paper_deadline": "YYYY-MM-DD or null", "deadline_tz": "e.g. PT, AoE, JST, UTC-5 or null",
 "deadline_evidence": "verbatim quote or null", "start_date": "YYYY-MM-DD or null",
 "end_date": "YYYY-MM-DD or null", "location": "City, Country or null",
 "dates_evidence": "verbatim quote or null", "note": "one short sentence (extensions, split deadlines) or null",
 "source_url": "URL the deadline came from or null", "edition_url": "official site of this edition or null",
 "used_web_search": true or false}}"""


def call_claude(prompt: str, web_search: bool) -> dict | None:
    body = {"model": MODEL, "max_tokens": 1200, "messages": [{"role": "user", "content": prompt}]}
    if web_search:
        body["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}]
    headers = {"x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    for attempt in range(3):
        try:
            r = requests.post(API_URL, headers=headers, json=body, timeout=120)
        except requests.RequestException as exc:
            log(f"    API error: {exc.__class__.__name__}")
            time.sleep(5 * (attempt + 1))
            continue
        if r.status_code in (429, 500, 502, 503, 529):
            time.sleep(10 * (attempt + 1))
            continue
        if r.status_code != 200:
            log(f"    API HTTP {r.status_code}: {r.text[:200]}")
            return None
        text = "\n".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
        m = re.search(r"\{[\s\S]*\}", text.replace("```json", "").replace("```", ""))
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    return None


def extract(s: dict, e: dict, pages: list[dict]) -> tuple[dict | None, list[dict], int]:
    """Returns (result, pages_used, api_calls)."""
    calls = 0
    fields = dict(name=e["name"], full=s["full"], year=e["year"], deadline=e.get("deadline"),
                  start=e.get("start"), end=e.get("end"), location=e.get("location"),
                  today=TODAY.isoformat())
    result = None
    if pages:
        material = "\n\n".join(f"--- Page: {p['url']} ({'official' if p['official'] else 'unofficial listing'}) ---\n{p['text']}"
                               for p in pages)
        result = call_claude(PROMPT.format(material=material, **fields), web_search=False)
        calls += 1
    need_search = (result is None or (not result.get("paper_deadline") and not e.get("deadline"))
                   or (not result.get("start_date") and not e.get("start")))
    if ALLOW_WEB_SEARCH and need_search:
        material = ("No usable official page text was available. Use web search to find the official "
                    f"site for {e['name']} and its call for papers. Prefer official IEEE/ACM or conference pages.")
        if pages:
            material = "Page text did not contain the answer. " + material
        r2 = call_claude(PROMPT.format(material=material, **fields), web_search=True)
        calls += 1
        if r2:
            r2["used_web_search"] = True
            if result is None:
                result = r2
            else:
                for k, v in r2.items():
                    if not result.get(k) and v:
                        result[k] = v
                result["used_web_search"] = result.get("used_web_search") or bool(r2.get("paper_deadline"))
    return result, pages, calls


# ---------------------------------------------------------------- verification
def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def evidence_level(quote, pages: list[dict], used_search: bool) -> str:
    """official-page | listing | web-search | none"""
    q = norm(quote)
    if len(q) >= 8:
        for p in pages:
            if q in norm(p["text"]):
                return "official-page" if p["official"] else "listing"
        # tolerate small quote differences: most words present in one page
        words = [w for w in q.split() if len(w) > 2]
        for p in pages:
            t = norm(p["text"])
            if words and sum(w in t for w in words) / len(words) >= 0.85:
                return "official-page" if p["official"] else "listing"
    return "web-search" if used_search and q else "none"


MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def quote_has_date(quote, day: dt.date | None) -> bool:
    """The evidence quote must actually state the claimed date (day + month)."""
    if not day or not quote:
        return False
    q = quote.lower()
    if day.isoformat() in q or f"{day:%Y/%m/%d}" in q:
        return True
    has_month = MONTH_ABBR[day.month - 1] in q or re.search(rf"\b0?{day.month}[/.-]0?{day.day}\b|\b0?{day.day}[/.-]0?{day.month}\b", q)
    has_day = re.search(rf"(?<!\d)0?{day.day}(st|nd|rd|th)?(?!\d)", q)
    return bool(has_month and has_day)


def sanity(e: dict, dl, st, en) -> list[str]:
    """Rules any accepted dates must satisfy. Returns problems."""
    p = []
    if st and st.year != e["year"]:
        p.append(f"start date {st} is not in {e['year']}")
    if st and en and en < st:
        p.append("end date before start date")
    if st and en and (en - st).days > 10:
        p.append("conference longer than 10 days")
    if dl and st and dl >= st:
        p.append("deadline is on/after the conference start")
    if dl and st and (st - dl).days > 430:
        p.append("deadline more than ~14 months before the conference")
    if dl and dl.year < e["year"] - 1:
        p.append(f"deadline year {dl.year} too early for the {e['year']} edition")
    return p


def apply_result(s, e, res, pages, changes, reviews) -> None:
    used = bool(res.get("used_web_search"))
    dl_ev = evidence_level(res.get("deadline_evidence"), pages, used)
    dt_ev = evidence_level(res.get("dates_evidence"), pages, used)
    # a quote only counts if it states the date it is supposed to prove
    if not quote_has_date(res.get("deadline_evidence"), pdate(res.get("paper_deadline"))):
        dl_ev = "none"
    if not quote_has_date(res.get("dates_evidence"), pdate(res.get("start_date"))):
        dt_ev = "none"

    new = {
        "deadline": pdate(res.get("paper_deadline")),
        "start": pdate(res.get("start_date")),
        "end": pdate(res.get("end_date")),
    }
    old = {k: pdate(e.get(k)) for k in new}
    # evaluate with the combination that would result
    merged = {k: new[k] or old[k] for k in new}
    problems = sanity(e, merged["deadline"], merged["start"], merged["end"])
    src = res.get("source_url") if isinstance(res.get("source_url"), str) and res["source_url"].startswith("http") else None
    if not src and pages:
        src = pages[0]["url"]

    def queue(field, oldv, newv, why, level):
        item = {"edition": e["id"], "field": field, "old": oldv, "new": newv, "reason": why,
                "evidence": res.get("deadline_evidence") if field == "deadline" else res.get("dates_evidence"),
                "evidence_level": level, "source": src, "found": TODAY.isoformat()}
        if not any(r["edition"] == item["edition"] and r["field"] == field and r["new"] == newv for r in reviews):
            reviews.append(item)
            log(f"    ? review {e['id']} {field}: {oldv} -> {newv} ({why})")

    if problems:
        for f in ("deadline", "start", "end"):
            if new[f] and new[f] != old[f]:
                queue(f, e.get(f), new[f].isoformat(), "; ".join(problems), dl_ev if f == "deadline" else dt_ev)
        return

    touched = False
    for f in ("deadline", "start", "end"):
        nv, ov = new[f], old[f]
        if not nv or nv == ov:
            continue
        level = dl_ev if f == "deadline" else dt_ev
        pinned = f in (e.get("pinned") or [])
        # How trustworthy is this?
        trusted = level == "official-page"
        fill_in = ov is None and level in ("official-page", "listing", "web-search")
        if f == "deadline" and ov:
            delta = (nv - ov).days
            if pinned:
                queue(f, ov.isoformat(), nv.isoformat(), "field is pinned by a maintainer", level); continue
            if trusted and 0 < delta <= MAX_AUTO_EXTENSION_DAYS:
                e[f] = nv.isoformat(); touched = True
                changes.append(change(e["id"], "extended", f, ov.isoformat(), nv.isoformat(),
                                      f"{e['name']} deadline extended to {nv:%d %b %Y} (was {ov:%d %b}).", src))
                continue
            queue(f, ov.isoformat(), nv.isoformat(),
                  f"deadline moved {delta:+d} days" + ("" if trusted else f", evidence: {level}"), level)
            continue
        if f in ("start", "end") and ov:
            if pinned or not trusted or abs((nv - ov).days) > MAX_AUTO_DATE_SHIFT:
                queue(f, ov.isoformat(), nv.isoformat(), f"conference {f} date changed" +
                      ("" if trusted else f", evidence: {level}"), level)
                continue
        if fill_in or (trusted and ov):
            e[f] = nv.isoformat(); touched = True
            kind = "announced" if ov is None else "changed"
            label = {"deadline": "paper deadline", "start": "start date", "end": "end date"}[f]
            changes.append(change(e["id"], kind, f, ov.isoformat() if ov else None, nv.isoformat(),
                                  f"{e['name']} {label} {'announced' if ov is None else 'changed'}: {nv:%d %b %Y}.", src))
        elif level == "none":
            queue(f, ov.isoformat() if ov else None, nv.isoformat(), "no verifiable evidence", level)

    loc = res.get("location")
    if isinstance(loc, str) and loc.lower() != "null" and 2 < len(loc) < 80 and loc != e.get("location") \
            and "location" not in (e.get("pinned") or []):
        if not e.get("location") or dt_ev == "official-page":
            changes.append(change(e["id"], "announced" if not e.get("location") else "changed", "location",
                                  e.get("location"), loc, f"{e['name']} location: {loc}.", src))
            e["location"] = loc; touched = True

    tz = res.get("deadline_tz")
    if isinstance(tz, str) and tz.lower() != "null" and len(tz) <= 12 and e.get("deadline") and not e.get("deadline_tz"):
        e["deadline_tz"] = tz

    note = res.get("note")
    if isinstance(note, str) and note.lower() != "null" and 5 < len(note) <= 240 and "note" not in (e.get("pinned") or []):
        e["note"] = note

    eu = res.get("edition_url")
    if isinstance(eu, str) and eu.startswith("http") and len(eu) < 200 and e.get("url") == s["url"]:
        e["url"] = eu

    if touched:
        e["last_changed"] = TODAY.isoformat()
        e["source"] = src
        best = dl_ev if new["deadline"] else dt_ev
        e["confidence"] = best if best != "none" else e.get("confidence", "unverified")
    elif e.get("confidence") == "seed" and dl_ev == "official-page" and new["deadline"] == old["deadline"] and old["deadline"]:
        e["confidence"] = "official-page"   # seed value confirmed on the official page
        e["source"] = src


# ---------------------------------------------------------------- review actions
def resolve_reviews(eid: str, accept: bool) -> None:
    editions = load_json(EDITIONS_FILE, [])
    reviews = load_json(REVIEW_FILE, [])
    changes = load_json(CHANGELOG_FILE, [])
    mine = [r for r in reviews if r["edition"] == eid]
    if not mine:
        sys.exit(f"No pending review items for {eid}")
    if accept:
        e = next(x for x in editions if x["id"] == eid)
        for r in mine:
            e[r["field"]] = r["new"]
            changes.append(change(eid, "changed", r["field"], r["old"], r["new"],
                                  f"{e['name']} {r['field']} updated to {r['new']} (reviewed).", r.get("source")))
        e["last_changed"] = TODAY.isoformat()
        e["confidence"] = "reviewed"
    save_json(REVIEW_FILE, [r for r in reviews if r["edition"] != eid])
    save_json(EDITIONS_FILE, editions)
    save_json(CHANGELOG_FILE, changes)
    log(f"{'Accepted' if accept else 'Rejected'} {len(mine)} item(s) for {eid}")


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--series")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--accept")
    ap.add_argument("--reject")
    a = ap.parse_args()

    if a.accept or a.reject:
        resolve_reviews(a.accept or a.reject, accept=bool(a.accept))
        return 0

    series, shared = load_series()
    by_id = {s["id"]: s for s in series}
    editions = load_json(EDITIONS_FILE, [])
    changes: list[dict] = []
    reviews = load_json(REVIEW_FILE, [])
    n_reviews_before = len(reviews)

    log(f"Tracker run {NOW:%Y-%m-%d %H:%M} UTC, model {MODEL}")
    editions = [e for e in editions if e["series"] in by_id]
    rollover(series, editions, changes)

    todo = [e for e in editions if not is_held(e)]
    if a.series:
        todo = [e for e in todo if e["series"] == a.series]
    elif not a.all:
        todo = [e for e in todo if is_due(e)]
    todo.sort(key=priority)
    skipped = max(0, len(todo) - MAX_CHECKS)
    todo = todo[:MAX_CHECKS]
    log(f"{len(todo)} edition(s) due for a check" + (f", {skipped} deferred to the next run" if skipped else ""))

    api_calls = errors = checked = 0
    if not API_KEY and not a.dry_run:
        log("ANTHROPIC_API_KEY is not set: skipping web checks (rollover and feeds still run).")
        todo = []
    for e in todo:
        s = by_id[e["series"]]
        log(f"- {e['id']}")
        if a.dry_run:
            continue
        pages = gather_pages(s, e, shared)
        log(f"    {len(pages)} page(s) with date text")
        res, pages, calls = extract(s, e, pages)
        api_calls += calls
        e["last_checked"] = NOW.isoformat(timespec="seconds")
        checked += 1
        if not res:
            errors += 1
            log("    no result")
            continue
        apply_result(s, e, res, pages, changes, reviews)

    if a.dry_run:
        log("Dry run: nothing written.")
        return 0

    editions.sort(key=lambda x: (x["series"], x["year"]))
    save_json(EDITIONS_FILE, editions)
    save_json(CHANGELOG_FILE, (load_json(CHANGELOG_FILE, []) + changes)[-500:])
    save_json(REVIEW_FILE, reviews)
    save_json(SERIES_JSON, [{k: s.get(k) for k in ("id", "name", "full", "org", "category", "focus", "url", "typical")}
                            for s in series])
    meta = load_json(META_FILE, {})
    meta.update({"last_run": NOW.isoformat(timespec="seconds"), "checked": checked, "api_calls": api_calls,
                 "errors": errors, "deferred": skipped, "changes": len(changes),
                 "pending_review": len(reviews), "model": MODEL,
                 "tracked_series": len(series), "tracked_editions": len(editions)})
    save_json(META_FILE, meta)

    new_reviews = reviews[n_reviews_before:]
    if new_reviews:
        lines = ["The tracker found changes it could not verify automatically.", "",
                 "| Edition | Field | Current | Found | Why | Evidence | Source |", "|---|---|---|---|---|---|---|"]
        for r in new_reviews:
            ev = (r.get("evidence") or "").replace("|", "/")[:120]
            lines.append(f"| {r['edition']} | {r['field']} | {r['old']} | **{r['new']}** | {r['reason']} | "
                         f"{r['evidence_level']}: {ev} | {r.get('source') or ''} |")
        lines += ["", "To apply: run the **Resolve review** workflow with the edition id and `accept`,",
                  "or edit `docs/data/editions.json` by hand. To discard, run it with `reject`."]
        REVIEW_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")

    log(f"Done: {checked} checked, {api_calls} API calls, {len(changes)} change(s), "
        f"{len(new_reviews)} new review item(s), {errors} error(s).")

    # rebuild feeds and validate
    sys.path.insert(0, str(Path(__file__).parent))
    import build_feeds  # noqa: E402
    import validate     # noqa: E402
    build_feeds.main()
    return validate.main()


if __name__ == "__main__":
    sys.exit(main())
