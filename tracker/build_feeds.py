#!/usr/bin/env python3
"""Builds docs/feed.xml (RSS of changes) and docs/deadlines.ics (calendar subscription)."""
from __future__ import annotations

import datetime as dt
import json
import os
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA = DOCS / "data"
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")
if not SITE_URL and "/" in os.environ.get("GITHUB_REPOSITORY", ""):
    _owner, _repo = os.environ["GITHUB_REPOSITORY"].split("/", 1)
    SITE_URL = f"https://{_owner}.github.io/{_repo}"
TODAY = dt.date.today()


def load(name, default):
    try:
        return json.loads((DATA / name).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def d(s):
    try:
        return dt.date.fromisoformat(s) if s else None
    except ValueError:
        return None


def build_rss(changes: list[dict]) -> str:
    items = []
    for i, c in enumerate(reversed(changes[-60:])):
        if c.get("kind") == "note":
            continue
        day = d(c["date"]) or TODAY
        pub = format_datetime(dt.datetime(day.year, day.month, day.day, 12, tzinfo=dt.timezone.utc))
        link = c.get("source") or SITE_URL or "https://github.com"
        guid = f"{c.get('edition')}-{c.get('field')}-{c.get('new')}-{c['date']}"
        items.append(f"""  <item>
    <title>{escape(c['message'])}</title>
    <link>{escape(link)}</link>
    <guid isPermaLink="false">{escape(guid)}</guid>
    <pubDate>{pub}</pubDate>
    <category>{escape(c.get('kind') or '')}</category>
  </item>""")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Chip conference deadlines: changes</title>
  <link>{escape(SITE_URL + '/updates.html' if SITE_URL else 'https://github.com')}</link>
  <description>New editions, announced deadlines and extensions for analog, VLSI and CAS conferences.</description>
  <lastBuildDate>{format_datetime(dt.datetime.now(dt.timezone.utc))}</lastBuildDate>
{chr(10).join(items)}
</channel>
</rss>
"""


def ics_escape(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def fold(line: str) -> str:
    out, b = [], line.encode("utf-8")
    while len(b) > 74:
        cut = 74
        while (b[cut] & 0xC0) == 0x80:
            cut -= 1
        out.append(b[:cut].decode("utf-8"))
        b = b" " + b[cut:]
    out.append(b.decode("utf-8"))
    return "\r\n".join(out)


def build_ics(editions: list[dict], series: dict) -> str:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    ev = []
    for e in editions:
        end_or_start = d(e.get("end")) or d(e.get("start"))
        if end_or_start and end_or_start < TODAY - dt.timedelta(days=30):
            continue
        full = series.get(e["series"], {}).get("full", "")
        url = e.get("url") or ""
        dl = d(e.get("deadline"))
        if dl:
            tz = f" ({e['deadline_tz']})" if e.get("deadline_tz") else ""
            ev.append([
                "BEGIN:VEVENT", f"UID:{e['id']}-deadline@conference-tracker", f"DTSTAMP:{stamp}",
                f"DTSTART;VALUE=DATE:{dl:%Y%m%d}", f"DTEND;VALUE=DATE:{dl + dt.timedelta(days=1):%Y%m%d}",
                f"SUMMARY:{ics_escape(e['name'] + ' paper deadline' + tz)}",
                f"DESCRIPTION:{ics_escape(full + chr(10) + (e.get('note') or '') + chr(10) + url)}",
                f"URL:{url}", "BEGIN:VALARM", "TRIGGER:-P7D", "ACTION:DISPLAY",
                f"DESCRIPTION:{ics_escape(e['name'] + ' deadline in 7 days')}", "END:VALARM", "END:VEVENT"])
        st, en = d(e.get("start")), d(e.get("end")) or d(e.get("start"))
        if st:
            ev.append([
                "BEGIN:VEVENT", f"UID:{e['id']}-conference@conference-tracker", f"DTSTAMP:{stamp}",
                f"DTSTART;VALUE=DATE:{st:%Y%m%d}", f"DTEND;VALUE=DATE:{en + dt.timedelta(days=1):%Y%m%d}",
                f"SUMMARY:{ics_escape(e['name'])}", f"LOCATION:{ics_escape(e.get('location') or '')}",
                f"DESCRIPTION:{ics_escape(full + chr(10) + url)}", f"URL:{url}", "TRANSP:TRANSPARENT", "END:VEVENT"])
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//conference-tracker//EN", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", "X-WR-CALNAME:Chip conference deadlines", "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
             "X-PUBLISHED-TTL:PT12H"]
    for block in ev:
        lines += block
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(l) for l in lines) + "\r\n"


def main() -> None:
    editions = load("editions.json", [])
    changes = load("changelog.json", [])
    series = {s["id"]: s for s in load("series.json", [])}
    (DOCS / "feed.xml").write_text(build_rss(changes), encoding="utf-8")
    (DOCS / "deadlines.ics").write_text(build_ics(editions, series), encoding="utf-8", newline="")
    print(f"Feeds built: {len(changes)} changelog entries, {len(editions)} editions.")


if __name__ == "__main__":
    main()
