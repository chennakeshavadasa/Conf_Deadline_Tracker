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
  let view = "upcoming", layout = "list";

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
        return `<article class="row ${st}">
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

  // ---------- timeline (Gantt: deadline ◆ → waiting period → conference bar) ----------
  function renderTimeline(list) {
    const now = new Date();
    const t0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const t1 = new Date(now.getFullYear(), now.getMonth() + TL_MONTHS, 1).getTime();
    const pct = t => Math.max(0, Math.min(100, (t - t0) / (t1 - t0) * 100));
    const inWin = t => t != null && t >= t0 && t < t1;

    const rows = list.filter(e => inWin(deadlineMs(e)) || inWin(startOf(e.start)));
    const hidden = list.length - rows.length;

    let months = "", grid = "";
    for (let i = 0; i < TL_MONTHS; i++) {
      const a = new Date(now.getFullYear(), now.getMonth() + i, 1), b = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const l = pct(a.getTime()), w = pct(b.getTime()) - l;
      const yr = a.getMonth() === 0 || i === 0;
      months += `<div class="tl-month" style="left:${l}%;width:${w}%">${a.toLocaleDateString(undefined, { month: "short" })}${yr ? `<small>${a.getFullYear()}</small>` : ""}</div>`;
      if (i) grid += `<i class="${a.getMonth() === 0 ? "yr" : ""}" style="left:${l}%"></i>`;
    }
    const nowPct = pct(now.getTime());

    const body = rows.map(e => {
      const st = status(e), dl = deadlineMs(e), cs = startOf(e.start), ce = e.end ? startOf(e.end) + DAY : cs ? cs + DAY : null;
      let html = "";
      // waiting period between deadline and conference
      if (dl && cs && cs > dl && (inWin(dl) || inWin(cs) || (dl < t0 && cs >= t0))) {
        const a = pct(dl), b = pct(cs);
        if (b > a) html += `<span class="tl-wait" style="left:${a}%;width:${b - a}%"></span>`;
      }
      // conference bar
      if (cs && cs < t1) {
        const a = pct(cs), b = pct(ce);
        html += `<span class="tl-conf" style="left:${a}%;width:max(8px, ${b - a}%)" title="${esc(e.name)}: ${fmtRange(e)}"></span>`;
        const txt = `${fmtRange(e, true)}${e.location ? ", " + esc(e.location.split(",")[0]) : ""}`;
        html += a > 72 ? `<span class="tl-txt left" style="left:calc(${a}% - 6px)">${txt}</span>`
                       : `<span class="tl-txt" style="left:calc(${b}% + 8px)">${txt}</span>`;
      } else if (cs && cs >= t1) {
        html += `<span class="tl-more">Conference ${fmtShort(e.start)} ${new Date(cs).getFullYear()} →</span>`;
      }
      // deadline diamond
      if (inWin(dl)) {
        const a = pct(dl);
        html += `<span class="tl-dl" style="left:${a}%" title="Paper deadline ${fmt(e.deadline)}"></span>`;
        html += a > 80 ? `<span class="tl-txt dlt left" style="left:calc(${a}% - 12px)">${fmtShort(e.deadline)}</span>`
                       : `<span class="tl-txt dlt" style="left:calc(${a}% + 12px)">${fmtShort(e.deadline)}</span>`;
      }
      const sub = e.deadline ? `${isOpen(st) ? "Due" : st === "closed" ? "Closed" : ""} ${fmt(e.deadline)}` : "Deadline not announced";
      return `<div class="tl-row s-${st}">
        <div class="tl-label"><b>${esc(e.name)}</b><span>${sub}</span></div>
        <div class="tl-track">${html}</div></div>`;
    }).join("");

    $("#timelineView").innerHTML = `
      <div class="tl-top">
        <h2>Next ${TL_MONTHS} months</h2>
        <ul class="legend">
          <li><span class="lg-dl"></span>Paper deadline</li>
          <li><span class="lg-wait"></span>Review period</li>
          <li><span class="lg-conf"></span>Conference</li>
          <li><span class="lg-today"></span>Today</li>
        </ul>
      </div>
      ${rows.length ? `<div class="tl-scroll"><div class="tl">
        <div class="tl-head"><div class="corner">Conference</div><div class="tl-months">${months}<span class="tl-now-tag" style="left:${nowPct}%">Today</span></div></div>
        <div class="tl-body">
          <div class="tl-grid">${grid}<div class="tl-now" style="left:${nowPct}%"></div></div>
          ${body}
        </div></div></div>` : `<div class="empty">Nothing in the next ${TL_MONTHS} months matches these filters.</div>`}
      ${hidden > 0 && rows.length ? `<p class="tl-foot">${hidden} more conference${hidden > 1 ? "s" : ""} fall outside this window. Switch to List to see them.</p>` : ""}`;
  }

  // ---------- orchestration ----------
  function renderMain() {
    const list = filtered();
    const open = list.filter(e => isOpen(status(e))).length;
    $("#countLine").textContent = `${list.length} conference${list.length === 1 ? "" : "s"} shown, ${open} with open deadlines`;
    $("#listView").hidden = layout !== "list";
    $("#timelineView").hidden = layout !== "timeline";
    layout === "list" ? renderList(list) : renderTimeline(list);
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
    history.replaceState(null, "", `#${layout}`);
  }));
  seg("view", v => view = v);
  seg("layout", v => layout = v);
  if (location.hash === "#timeline") document.querySelector('[data-layout="timeline"]').click();
  ["#q", "#catSel", "#sortSel"].forEach(s => $(s).addEventListener("input", renderMain));

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
