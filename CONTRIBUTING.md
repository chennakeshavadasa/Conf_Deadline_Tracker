# Contributing

Thanks for helping keep the deadlines accurate. There are three ways to help.

## 1. Report a wrong or missing date

Use the **Report a wrong date** link next to any conference on the site, or
open an issue with the *Report a wrong date* template. Please include a link to
the conference's own page (or the IEEE/ACM listing) that shows the correct
value. Maintainers can only publish changes that have an official source.

## 2. Suggest a conference

Open an issue with the *Suggest a conference* template. Good candidates are
peer-reviewed conferences with IEEE Xplore or ACM proceedings that circuit,
VLSI or EDA students regularly submit to.

## 3. Add a conference yourself (pull request)

Add one entry to `tracker/series.yml`:

```yaml
  - id: islped                 # lowercase letters/digits, unique
    name: ISLPED               # display name without the year
    full: International Symposium on Low Power Electronics and Design
    org: ACM / IEEE
    category: eda              # t1 | ssc | casf | cas | eda
    focus: Low-power circuits and design
    url: https://www.islped.org/
    edition_url: https://www.islped.org/{year}/   # optional, if each year has its own site
    extra_urls: ["https://www.islped.org/{year}/cfp/"]  # optional; keep URLs with {year} in quotes
    typical: Paper deadline usually March          # optional hint shown until announced
```

You don't need to add dates. On its next run the bot creates the current
edition and finds the dates on the official site.

Before opening the pull request, run:

```bash
pip install -r requirements.txt
python tracker/validate.py
```

The same check runs automatically on your pull request.

## Editing dates by hand (maintainers)

Edit the edition in `docs/data/editions.json`:

- set the corrected value, `"source"` to the official URL, and `"confidence": "manual"`
- to stop the bot from changing a field without review, list it in `"pinned"`,
  for example `"pinned": ["deadline"]`

The bot never overwrites a pinned field automatically. If it later finds a
different value, it opens a review issue instead.

## Data rules

The validator enforces these, and the bot uses the same rules before
publishing anything:

- dates are `YYYY-MM-DD`
- the conference start date is in the edition's year
- the end date is on or after the start date
- the paper deadline is before the conference starts
- edition ids are `<series>-<year>`, e.g. `iscas-2027`
