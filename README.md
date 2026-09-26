# Chip conference deadlines

A self-updating tracker of paper deadlines for analog, mixed-signal, VLSI and
circuits & systems conferences (ISSCC, VLSI Symposium, CICC, ISCAS, BioCAS,
AICAS, NEWCAS, A-SSCC, ESSERC, RFIC, DAC and 20+ more), published as a website
on GitHub Pages.

**Live site:** `https://chennakeshavadasa.github.io/Conf_Deadline_Tracker/`

Students get live countdowns, a timeline, a calendar subscription that updates
itself, and an RSS feed of extensions and newly announced deadlines.

---

## How tracking works

The data is **not** a static list. A GitHub Action runs every day and maintains it:

```
 tracker/series.yml          one entry per recurring conference (ISCAS, CICC, ...)
        │
        ▼
 ┌─────────────── daily GitHub Action (tracker/track.py) ───────────────┐
 │ 1. Roll over   an edition ended?  → add next year's edition           │
 │ 2. Schedule    what is due today? (see table below)                   │
 │ 3. Fetch       official site + IEEE listings, keep only date text     │
 │ 4. Extract     Claude reads the text, returns dates + verbatim quote  │
 │ 5. Verify      quote must exist on the page AND contain the date,     │
 │                dates must pass sanity rules                           │
 │ 6. Publish     safe changes → site + changelog                        │
 │                risky changes → GitHub issue for a human               │
 └───────────────────────────────────────────────────────────────────────┘
        │
        ▼
 docs/data/*.json  →  website, docs/deadlines.ics, docs/feed.xml
```

### It follows conferences, not years

Each conference is tracked as a **series**. When ISCAS 2027 ends, the bot
creates ISCAS 2028 automatically and starts looking for its dates, so the site
never fills up with past events.

### Check schedule

| Edition state | Checked every |
|---|---|
| Deadline within 30 days | 1 day (extensions usually appear here) |
| Deadline not announced yet | 3 days |
| Deadline open, more than 30 days away | 7 days |
| Deadline passed, conference still ahead | 14 days (dates or venue can still change) |
| Conference over | never (next edition is added instead) |

At most `MAX_CHECKS` editions (default 25) are checked per run, soonest
deadline first. Anything left over is picked up the next day.

### What gets published automatically, and what waits for a human

| Situation | Result |
|---|---|
| Deadline announced for the first time, with evidence | Published, logged as **Announced** |
| Deadline moved later by 1–45 days, quote verified on the official page | Published, logged as **Extended** |
| Deadline moved earlier, or by more than 45 days | Held for review |
| Change supported only by web search, not the official page | Held for review |
| Quote not found on the page, or doesn't contain the date | Held for review |
| Dates break a rule (deadline after conference start, wrong year, etc.) | Held for review |
| Field is pinned by a maintainer | Held for review |

"Held for review" means the site keeps the old value and the bot opens (or
comments on) a GitHub issue titled **"Tracker: changes need a human check"**
with the old value, the new value, the quote and the source link.

Every entry on the site shows how it was verified ("Verified on official page",
"From web search, not yet confirmed", ...) and when it was last checked. If the
bot stops running for more than two days, the site shows a warning at the top.

---

## Setup (about 10 minutes)

1. **Create the repository.** On GitHub, create a new public repository (for
   example `conference-deadlines`) and upload everything in this folder,
   keeping the folder structure. Or from a terminal:
   ```bash
   git init && git add . && git commit -m "Initial tracker"
   git branch -M main
   git remote add origin https://github.com/<you>/conference-deadlines.git
   git push -u origin main
   ```

2. **Add your API key.** Get a key from the Anthropic Console
   (console.anthropic.com). In the repository go to
   **Settings → Secrets and variables → Actions → New repository secret**.
   Name: `ANTHROPIC_API_KEY`, value: your key.

3. **Let the bot commit.** **Settings → Actions → General → Workflow
   permissions** → select **Read and write permissions** → Save.

4. **Turn on the website.** **Settings → Pages** → Source: **Deploy from a
   branch** → Branch: `main`, folder: `/docs` → Save. After a minute the site is
   live at `https://<you>.github.io/conference-deadlines/`.

5. **Run the first check.** **Actions → Track conferences → Run workflow**.
   The first two runs verify all the starting data against the official pages
   (25 per run). After that it runs by itself every day at 02:17 UTC.

That's it. The site works immediately after step 4 using the starting data;
the bot keeps it current from step 5 on.

### Optional settings

Under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model used for extraction. Check docs.claude.com for current model names. |
| `MAX_CHECKS` | `25` | Maximum editions checked per run. |
| `ALLOW_WEB_SEARCH` | `1` | Set to `0` to only read official pages (cheaper, but slower to discover new editions). |

To change the run time, edit the `cron` line in `.github/workflows/track.yml`.

### Cost

Each check sends only the date-related lines from a few pages (a few thousand
tokens), and web search is only used when the official page doesn't have the
answer. With about 40 conferences on the schedule above, expect roughly
**US$5–10 per month** in API usage. GitHub Actions and Pages are free for
public repositories. Lower `MAX_CHECKS` or set `ALLOW_WEB_SEARCH=0` to spend
less.

---

## Day-to-day maintenance

**When a review issue appears.** Open the source link and check the value.
Then go to **Actions → Resolve review → Run workflow**, enter the edition id
(for example `iscas-2027`) and choose `accept` or `reject`. Close the issue
once it's handled.

**When someone reports a wrong date.** Students use the "Report a wrong date"
link on the site, which opens a pre-filled issue. Fix it by editing
`docs/data/editions.json` directly on GitHub. Set `"confidence": "manual"`, and
if you don't want the bot to change that field again without asking, add it to
`"pinned"`, e.g. `"pinned": ["deadline"]`.

**Adding a conference.** Add an entry to `tracker/series.yml` (see
CONTRIBUTING.md). You don't need to add any dates: the bot creates the current
edition and finds them on its next run.

**Check a single conference now.** Actions → Track conferences → Run workflow →
enter the series id (e.g. `cicc`).

---

## Files

| Path | Purpose |
|---|---|
| `tracker/series.yml` | The list of tracked conferences. The only file you normally edit. |
| `tracker/track.py` | The bot: rollover, scheduling, fetching, extraction, verification. |
| `tracker/build_feeds.py` | Builds the calendar (`deadlines.ics`) and RSS feed. |
| `tracker/validate.py` | Checks the data files for mistakes. Runs on every pull request. |
| `docs/` | The website served by GitHub Pages. |
| `docs/data/editions.json` | Current dates for every tracked edition (written by the bot). |
| `docs/data/changelog.json` | Every change the bot has made, with sources. |
| `docs/data/review.json` | Changes waiting for a human decision. |
| `docs/data/meta.json` | Stats from the last run, used for the health indicator. |
| `.github/workflows/track.yml` | Daily schedule. |
| `.github/workflows/resolve.yml` | Accept or reject held changes. |
| `.github/workflows/validate.yml` | Data checks on pull requests. |

### Categories

| Code | Meaning |
|---|---|
| `t1` | Top tier: ISSCC, VLSI Symposium, CICC |
| `ssc` | Other SSCS and RF venues: ESSERC, A-SSCC, RFIC |
| `casf` | IEEE CASS flagships (global, premier and regional) |
| `cas` | Other CASS-sponsored or co-sponsored conferences |
| `eda` | EDA, VLSI, test and devices |

---

## Running locally

```bash
pip install -r requirements.txt
python tracker/validate.py                 # check data
python tracker/track.py --dry-run          # see what would be checked today
export ANTHROPIC_API_KEY=sk-ant-...
python tracker/track.py --series iscas     # check one series for real
python -m http.server -d docs 8000         # preview the site at localhost:8000
```

## Limitations

- Dates come from conference websites, which are sometimes inconsistent with
  each other (for example NEWCAS 2027 lists 1 Feb on its own site and 8 Feb on
  the CASS site). The bot records a note when it notices this, but students
  should always confirm on the official page.
- Countdowns use fixed time-zone offsets and ignore daylight saving, so they can
  be off by an hour.
- Some conference sites block automated requests. For those the bot falls back
  to web search, and the result is marked as unconfirmed until it's verified.

## License

MIT. See `LICENSE`.
