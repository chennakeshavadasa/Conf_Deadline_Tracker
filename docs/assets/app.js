/* Chip conference deadlines: front end.
   Reads the JSON the tracker bot publishes in docs/data/ and renders it.
   Nothing here edits data; all updates come from the scheduled GitHub Action. */
(() => {
  const DAY = 864e5;
  const CAT = { t1: "Top tier", ssc: "SSCS / RF", casf: "CAS flagship", cas: "CAS", eda: "EDA / VLSI" };
  const VERIFY = {
    "official-page": "Verified on official page", reviewed: "Verified by a maintainer",
    listing: "From an IEEE listing", "web-search": "From web search, not yet confirmed",
    seed: "From the initial list", unverified: "Not yet verified", manual: "Entered by a maintainer",
  };
  // Fixed hour offsets for common deadline time zones (DST ignored, so countdowns are approximate)
  const TZ = { AOE: -12, HST: -10, PT: -8, PST: -8, PDT: -7, MT: -7, CT: -6, ET: -5, EST: -5, EDT: -4,
    UTC: 0, GMT: 0, CET: 1, CEST: 2, EET: 2, IST: 5.5, SGT: 8, KST: 9, JST: 9, AEST: 10 };
  const TL_MONTHS = 13;

  const $ = s => document.querySelector(s);
  let series = {}, editions = [], changes = [], meta = {};
  let view = "upcoming", showClosed = false;

  // ---------- helpers ----------
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const startOf = d => d ? new Date(d + "T00:00:00").getTime() : null;
  function tzOffset(tz) {
    if (!tz) return null;
    const k = tz.toUpperCase().replace(/\s/g, "");
    if (k in TZ) return TZ[k];
    const m = k.match(/^(UTC|GMT)([+\-−])(\d{1,2})(?::?(\d{2}))?$/);
    return m ? (m[2] === "+" ? 1 : -1) * (Number(m[3]) + Number(m[4] || 0) / 60) : null;
  }
  function deadlineMs(e) {
    if (!e.deadline) return null;
    const off = tzOffset(e.deadline_tz);
    if (off === null) return new Date(e.deadline + "T23:59:59").getTime();
    const [y, mo, d] = e.deadline.split("-").map(Number);
    return Date.UTC(y, mo - 1, d, 23, 59, 59) - off * 3600e3;
  }
  function status(e, now = Date.now()) {
    const t = deadlineMs(e);
    if (!t) return "tba";
    if (t < now) return "closed";
    return t - now <= 14 * DAY ? "soon" : "open";
  }
  const held = (e, now = Date.now()) => {
    const d = e.end || e.start;
    return d ? startOf(d) + DAY < now : e.year < new Date().getFullYear();
  };
  const fmt = d => d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  const fmtShort = d => d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  function fmtRange(e, short) {
    if (!e.start) return "Not announced";
    const f = short ? fmtShort : fmt;
    if (!e.end || e.end === e.start) return f(e.start);
    const a = new Date(e.start + "T00:00:00"), b = new Date(e.end + "T00:00:00");
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear())
      return `${a.getDate()}–${b.getDate()} ${b.toLocaleDateString(undefined, short ? { month: "short" } : { month: "short", year: "numeric" })}`;
    return `${f(e.start)} – ${f(e.end)}`;
  }
  function left(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600), m: Math.floor(s % 3600 / 60), s: s % 60 };
  }
  function ago(iso) {
    if (!iso) return "never";
    const h = (Date.now() - new Date(iso).getTime()) / 36e5;
    if (h < 1) return "just now";
    if (h < 24) return `${Math.round(h)} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? "yesterday" : `${d} days ago`;
  }
  function gcal(e) {
    const d = e.deadline.replace(/-/g, "");
    const n = new Date(startOf(e.deadline) + DAY);
    const p = new URLSearchParams({ action: "TEMPLATE", text: `${e.name} paper deadline`,
      dates: `${d}/${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}`,
      details: `${e.s.full || ""}\n${e.url || ""}` });
    return "https://calendar.google.com/calendar/render?" + p;
  }
  function repoUrl() {
    const cfg = (window.TRACKER_CONFIG || {}).repo;
    if (cfg) return cfg.replace(/\/$/, "");
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (!m) return "";
    const first = location.pathname.split("/").filter(Boolean)[0];
    return first && !first.includes(".") ? `https://github.com/${m[1]}/${first}` : `https://github.com/${m[1]}/${location.hostname}`;
  }
  const join = () => editions.map(e => ({ ...e, s: series[e.series] || { name: e.series, full: "", category: "eda" } }));
  const isOpen = st => st === "open" || st === "soon";

  // ---------- filtering (shared by list and timeline) ----------
  function filtered() {
    const q = $("#q").value.trim().toLowerCase(), cat = $("#catSel").value, sort = $("#sortSel").value;
    const now = Date.now(), order = { soon: 0, open: 1, tba: 2, closed: 3 };
    const list = join().filter(e => {
      const st = status(e, now);
      if (view === "open" && !isOpen(st)) return false;
      if (view === "upcoming" && held(e, now)) return false;
      if (cat && e.s.category !== cat) return false;
      if (q && !`${e.name} ${e.s.full} ${e.s.focus} ${e.location} ${e.s.org}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const confKey = e => startOf(e.start) || new Date(e.year, 11, 31).getTime();
    list.sort(sort === "conf" ? (a, b) => confKey(a) - confKey(b) : (a, b) => {
      const sa = status(a, now), sb = status(b, now);
      if (order[sa] !== order[sb]) return order[sa] - order[sb];
      return isOpen(sa) ? deadlineMs(a) - deadlineMs(b) : confKey(a) - confKey(b);
    });
    return list;
  }

  // ---------- header, hero, changes ----------
  function renderHealth() {
    const el = $("#health");
    if (!meta.last_run) { el.innerHTML = `<span class="dot"></span>Waiting for the first tracker run`; return; }
    const stale = (Date.now() - new Date(meta.last_run).getTime()) / 36e5 > 50;
    el.innerHTML = `<span class="dot ${stale ? "stale" : "ok"}"></span>` + (stale
      ? `Tracker hasn't run since <strong>${ago(meta.last_run)}</strong>. Dates may be out of date.`
      : `Last checked <strong>${ago(meta.last_run)}</strong>, tracking ${meta.tracked_series || Object.keys(series).length} conferences`);
  }

  function renderHero() {
    const now = Date.now();
    const open = join().filter(e => isOpen(status(e, now))).sort((a, b) => deadlineMs(a) - deadlineMs(b));
    const next = open[0];
    if (!next) { $("#hero").innerHTML = `<p class="lead">No open deadlines right now. New ones appear here as soon as they're announced.</p>`; return; }
    const t = left(deadlineMs(next) - now);
    const after = open.slice(1, 5).map(e => `<li><b>${esc(e.s.name)}</b> ${fmtShort(e.deadline)}</li>`).join("");
    $("#hero").innerHTML = `
      <div>
        <p class="lead">Next paper deadline</p>
        <div class="name">${esc(next.name)}</div>
        <p class="meta">Due ${fmt(next.deadline)}${next.deadline_tz ? ", 23:59 " + esc(next.deadline_tz) : ""}. Conference ${fmtRange(next)}${next.location ? " in " + esc(next.location) : ""}.</p>
      </div>
      <div class="clock" role="timer" aria-label="${t.d} days ${t.h} hours left">
        <div><span>${t.d}</span><small>days</small></div>
        <div><span>${pad(t.h)}</span><small>hours</small></div>
        <div><span>${pad(t.m)}</span><small>minutes</small></div>
        <div><span>${pad(t.s)}</span><small>seconds</small></div>
      </div>
      ${after ? `<div><p class="lead" style="margin-bottom:8px">After that</p><ul class="next">${after}</ul></div>` : ""}`;
  }

  function renderChanges() {
    const label = { extended: "Extended", announced: "Announced", "new-edition": "New edition", changed: "Changed" };
    const list = changes.filter(c => c.kind !== "note").slice(-20).reverse();
    $("#changes").innerHTML = list.length ? list.map(c =>
      `<li><time>${fmt(c.date)}</time><span class="kind ${esc(c.kind)}">${label[c.kind] || esc(c.kind)}</span>${esc(c.message)}${c.source ? ` <a href="${esc(c.source)}" target="_blank" rel="noopener">Source</a>` : ""}</li>`
    ).join("") : `<li>No changes yet. Extensions and newly announced deadlines will show up here as the bot finds them.</li>`;
  }

  // ---------- list ----------
  function renderList(list) {
    if (!list.length) { $("#listView").innerHTML = `<div class="empty">No conferences match. Clear the search or choose another category.</div>`; return; }
    const lab = { open: "Open", soon: "Closing soon", closed: "Closed", tba: "Not announced" };
    const repo = repoUrl(), now = Date.now();
    $("#listView").innerHTML = `<div class="row headrow"><div>Conference</div><div>Conference dates</div><div>Location</div><div>Paper deadline</div><div>Links</div></div>` +
      list.map(e => {
        const st = status(e, now);
        const fix = repo ? `${repo}/issues/new?template=correction.yml&title=${encodeURIComponent("Correction: " + e.name)}` : "";
        return `<article class="row ${st}" id="row-${esc(e.id)}">
          <div class="c1"><div class="cname">${esc(e.name)}</div><div class="cfull">${esc(e.s.full)}</div>
            <span class="tier ${e.s.category === "t1" ? "t1" : ""}">${CAT[e.s.category] || ""}</span></div>
          <div><div class="lbl">Conference dates</div><div class="val">${fmtRange(e)}</div></div>
          <div><div class="lbl">Location</div><div class="val">${esc(e.location) || "Not announced"}</div></div>
          <div><div class="lbl">Paper deadline</div>
            <div class="dl">${e.deadline ? fmt(e.deadline) : "TBA"}${e.deadline && e.deadline_tz ? `<span class="tz">${esc(e.deadline_tz)}</span>` : ""}</div>
            <span class="badge b-${st}">${lab[st]}</span>
            ${isOpen(st) ? `<div class="count" data-e="${esc(e.id)}"></div>` : ""}
            ${st === "tba" && e.s.typical ? `<div class="hint">${esc(e.s.typical)}</div>` : ""}</div>
          <div class="c5 acts">
            <a href="${esc(e.url || e.s.url)}" target="_blank" rel="noopener">Official website</a>
            ${isOpen(st) ? `<a href="${gcal(e)}" target="_blank" rel="noopener">Add to calendar</a>` : ""}
            ${fix ? `<a href="${fix}" target="_blank" rel="noopener">Report a wrong date</a>` : ""}
          </div>
          <div class="meta-line">
            <span class="v v-${esc(e.confidence)}">${VERIFY[e.confidence] || esc(e.confidence)}</span>
            <span>Checked ${ago(e.last_checked)}</span>
            ${e.source ? `<a href="${esc(e.source)}" target="_blank" rel="noopener">Source</a>` : ""}
            ${e.note ? `<span class="note">${esc(e.note)}</span>` : ""}
          </div>
        </article>`;
      }).join("");
    tick();
  }

  // ---------- timeline: one row per conference  ◆ deadline ── time until conference ── ▬ conference ----------
  function renderTimeline(list) {
    const MONTHS = 13, now = Date.now(), nd = new Date(now);
    const t0 = new Date(nd.getFullYear(), nd.getMonth(), 1).getTime();
    const t1 = new Date(nd.getFullYear(), nd.getMonth() + MONTHS, 1).getTime();
    const pct = t => (t - t0) / (t1 - t0) * 100;
    const clamp = p => Math.max(0, Math.min(100, p));
    const inWin = t => t != null && t >= t0 && t < t1;
    const confStart = e => startOf(e.start), confEnd = e => e.end ? startOf(e.end) + DAY : (e.start ? startOf(e.start) + DAY : null);

    // rows: anything with a deadline or conference inside the window
    const rows = list.filter(e => inWin(deadlineMs(e)) || inWin(confStart(e)) ||
      (deadlineMs(e) && deadlineMs(e) < t0 && confStart(e) >= t1));
    const outside = list.length - rows.length;

    // header: years on top, months below
    let years = "", months = "", grid = "";
    let yStart = 0, yLabel = nd.getFullYear();
    for (let i = 0; i <= MONTHS; i++) {
      const d = new Date(nd.getFullYear(), nd.getMonth() + i, 1), p = pct(d.getTime());
      if (i === MONTHS || (d.getMonth() === 0 && i > 0)) {
        years += `<div class="tl-year" style="left:${yStart}%;width:${p - yStart}%">${yLabel}</div>`;
        yStart = p; yLabel = d.getFullYear();
      }
      if (i < MONTHS) {
        const w = pct(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()) - p;
        months += `<div class="tl-month${d.getMonth() === 0 ? " jan" : ""}" style="left:${p}%;width:${w}%">${d.toLocaleDateString(undefined, { month: "short" })}</div>`;
        if (i) grid += `<i class="${d.getMonth() === 0 ? "yr" : ""}" style="left:${p}%"></i>`;
      }
    }
    const pn = pct(now);

    const monthsBetween = (a, b) => {
      const m = (b - a) / (30.44 * DAY);
      return m < 1.5 ? `${Math.round((b - a) / DAY)} days` : `${Math.round(m)} months`;
    };

    const rowHtml = e => {
      const st = status(e, now), dl = deadlineMs(e), cs = confStart(e), ce = confEnd(e);
      let track = "";
      // band between deadline and conference
      if (dl && cs && cs > dl && (inWin(dl) || inWin(cs) || (dl < t0 && cs >= t0))) {
        const a = clamp(pct(dl)), b = clamp(pct(cs));
        if (b - a > 0.3) {
          const fadeL = dl < t0 ? " fade-l" : "", fadeR = cs >= t1 ? " fade-r" : "";
          track += `<span class="tl-gap${fadeL}${fadeR}" style="left:${a}%;width:${b - a}%"></span>`;
          if (b - a > 9) track += `<span class="tl-gap-txt" style="left:${(a + b) / 2}%">${monthsBetween(dl, cs)}</span>`;
        }
      }
      // conference bar + label
      if (cs && cs < t1) {
        const a = clamp(pct(cs)), b = clamp(pct(ce));
        const txt = `${fmtRange(e, true)}${e.location ? ", " + esc(e.location.split(",")[0]) : ""}`;
        track += `<span class="tl-conf" style="left:${a}%;width:max(10px, ${b - a}%)"></span>`;
        track += a > 74 ? `<span class="tl-conf-txt left" style="right:calc(${100 - a}% + 8px)">${txt}</span>`
                        : `<span class="tl-conf-txt" style="left:calc(${b}% + 10px)">${txt}</span>`;
      } else if (cs && cs >= t1) {
        track += `<span class="tl-beyond">Conference ${fmtShort(e.start)} ${new Date(cs).getFullYear()}</span>`;
      }
      // deadline diamond + date
      if (inWin(dl)) {
        const a = pct(dl);
        track += `<span class="tl-dl" style="left:${a}%"></span>`;
        track += a > 86 ? `<span class="tl-dl-txt left" style="right:calc(${100 - a}% + 14px)">${fmtShort(e.deadline)}</span>`
                        : `<span class="tl-dl-txt" style="left:calc(${a}% + 14px)">${fmtShort(e.deadline)}</span>`;
      }
      const days = dl ? Math.round(Math.abs(dl - now) / DAY) : 0;
      const chip = { open: "Open", soon: "Closing soon", closed: "Closed", tba: "TBA" }[st];
      const sub = st === "tba" ? (e.s.typical ? esc(e.s.typical.replace(/^Paper deadline usually /, "Usually ")) : "Not announced yet")
        : st === "closed" ? (days <= 30 ? `${fmtShort(e.deadline)}, ${days <= 1 ? "yesterday" : days + " days ago"}` : fmt(e.deadline))
        : days < 1 ? "Due today" : st === "soon" ? `${days} day${days === 1 ? "" : "s"} left`
        : `${fmtShort(e.deadline)}, in ${days} days`;
      return `<button type="button" class="tl-row s-${st}" data-id="${esc(e.id)}" aria-label="${esc(e.name)}. ${chip}. ${esc(sub)}. Conference ${fmtRange(e)}.">
        <span class="tl-label"><b>${esc(e.name)}</b><span class="tl-sub"><span class="chip c-${st}">${chip}</span>${sub}</span></span>
        <span class="tl-track">${track}</span>
      </button>`;
    };

    // group by deadline state when sorting by deadline
    let body = "";
    if ($("#sortSel").value === "deadline") {
      const groups = [
        ["Deadline open", rows.filter(e => isOpen(status(e, now)))],
        ["Deadline not announced", rows.filter(e => status(e, now) === "tba")],
        ["Closed, conference ahead", rows.filter(e => status(e, now) === "closed")],
      ];
      body = groups.filter(g => g[1].length).map(([t, g], i, arr) => {
        const closedGroup = t.startsWith("Closed");
        const collapsed = closedGroup && !showClosed && arr.length > 1;
        const toggle = closedGroup && arr.length > 1
          ? `<button type="button" class="tl-toggle" aria-expanded="${!collapsed}">${collapsed ? "Show" : "Hide"}</button>` : "";
        return `<div class="tl-group"><div class="tl-group-in"><span>${t}</span><em>${g.length}</em>${toggle}</div></div>` + (collapsed ? "" : g.map(rowHtml).join(""));
      }).join("");
    } else body = rows.map(rowHtml).join("");

    $("#timeline").innerHTML = rows.length ? `<div class="tl-scroll"><div class="tl">
        <div class="tl-head">
          <div class="corner">Conference</div>
          <div class="tl-scale"><div class="tl-years">${years}</div><div class="tl-months">${months}</div></div>
        </div>
        <div class="tl-body">
          <div class="tl-bg" aria-hidden="true"><span class="tl-past" style="width:${clamp(pn)}%"></span>${grid}<span class="tl-now" style="left:${pn}%"></span></div>
          ${body}
        </div>
        <div class="tl-foot"><div></div><div class="tl-foot-scale"><span class="tl-now-tag" style="left:${pn}%">Today</span></div></div>
      </div></div>
      <p class="tl-note">Click a row to see full details below.${outside > 0 ? ` ${outside} more conference${outside > 1 ? "s are" : " is"} outside this ${MONTHS}-month window and listed below.` : ""}</p>`
      : `<div class="empty">Nothing in the next ${MONTHS} months matches these filters.</div>`;
  }

  function jumpTo(id) {
    let el = document.getElementById("row-" + id);
    if (!el) {                                   // hidden by filters: clear them and try again
      $("#q").value = ""; $("#catSel").value = "";
      document.querySelector('[data-view="all"]').click();
      el = document.getElementById("row-" + id);
    }
    if (!el) return;
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }

  // ---------- orchestration ----------
  function renderMain() {
    const list = filtered();
    const open = list.filter(e => isOpen(status(e))).length;
    $("#countLine").textContent = `${list.length} conference${list.length === 1 ? "" : "s"} shown, ${open} with open deadlines`;
    renderTimeline(list);
    renderList(list);
  }
  function tick() {
    const now = Date.now(), byId = Object.fromEntries(editions.map(e => [e.id, e]));
    document.querySelectorAll("[data-e]").forEach(el => {
      const e = byId[el.dataset.e]; if (!e) return;
      const t = left(deadlineMs(e) - now);
      el.textContent = t.d > 0 ? `${t.d} days ${t.h} h left` : `${pad(t.h)}:${pad(t.m)}:${pad(t.s)} left`;
    });
  }
  function renderAll() { renderHealth(); renderHero(); renderChanges(); renderMain(); }

  async function getJSON(path, fallback) {
    try {
      const r = await fetch(`${path}?v=${Math.floor(Date.now() / 6e5)}`, { cache: "no-cache" });
      return r.ok ? await r.json() : fallback;
    } catch { return fallback; }
  }
  async function load() {
    const [s, e, c, m] = await Promise.all([getJSON("data/series.json", []), getJSON("data/editions.json", []),
      getJSON("data/changelog.json", []), getJSON("data/meta.json", {})]);
    series = Object.fromEntries(s.map(x => [x.id, x]));
    editions = e; changes = c; meta = m;
    if (!editions.length) { $("#listView").innerHTML = `<div class="empty">Couldn't load the conference data. Refresh the page to try again.</div>`; return; }
    renderAll();
  }

  // ---------- wiring ----------
  const seg = (attr, set) => document.querySelectorAll(`[data-${attr}]`).forEach(b => b.addEventListener("click", () => {
    set(b.dataset[attr]);
    document.querySelectorAll(`[data-${attr}]`).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    renderMain();
  }));
  seg("view", v => view = v);
  ["#q", "#catSel", "#sortSel"].forEach(s => $(s).addEventListener("input", renderMain));
  $("#timeline").addEventListener("click", ev => {
    if (ev.target.closest(".tl-toggle")) { showClosed = !showClosed; renderMain(); return; }
    const r = ev.target.closest(".tl-row"); if (r) jumpTo(r.dataset.id);
  });

  const icsAbs = new URL("deadlines.ics", location.href);
  const webcal = icsAbs.href.replace(/^https?:/, "webcal:");
  $("#subCal").href = webcal;
  $("#subGcal").href = "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(webcal);
  const repo = repoUrl();
  if (repo) $("#repoLinks").innerHTML = `Missing a conference? <a href="${repo}/issues/new?template=new-conference.yml" target="_blank" rel="noopener">Suggest one</a>. See <a href="${repo}/commits/main/docs/data/editions.json" target="_blank" rel="noopener">every data change</a> or the <a href="${repo}" target="_blank" rel="noopener">source code</a>.`;

  load();
  setInterval(() => { renderHero(); tick(); }, 1000);
  setInterval(() => { renderHealth(); renderMain(); }, 60e3);
  setInterval(load, 30 * 60e3);
})();
