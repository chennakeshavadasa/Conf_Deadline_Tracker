/* Chip conference deadlines: front end.
   Reads the JSON the tracker bot publishes in docs/data/ and renders it.
   Nothing here edits data; all updates come from the scheduled GitHub Action. */
(() => {
  const DAY = 864e5;
  const CAT = { t1: "Top tier", ssc: "SSCS / RF", casf: "CAS flagship", cas: "CAS", eda: "EDA / VLSI" };
  const VERIFY = {
    "official-page": "Verified on official page",
    "reviewed": "Verified by a maintainer",
    "listing": "From an IEEE listing",
    "web-search": "From web search, not yet confirmed",
    "seed": "From the initial list",
    "unverified": "Not yet verified",
    "manual": "Entered by a maintainer",
  };
  // Hour offsets for common deadline time zones (fixed, DST ignored: countdowns are approximate)
  const TZ = { AOE: -12, HST: -10, PT: -8, PST: -8, PDT: -7, MT: -7, CT: -6, ET: -5, EST: -5, EDT: -4,
    UTC: 0, GMT: 0, CET: 1, CEST: 2, EET: 2, IST: 5.5, CST_CN: 8, SGT: 8, KST: 9, JST: 9, AEST: 10 };

  const $ = s => document.querySelector(s);
  let series = {}, editions = [], changes = [], meta = {}, view = "upcoming";

  // ---------- helpers ----------
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const startOf = d => d ? new Date(d + "T00:00:00").getTime() : null;
  function tzOffset(tz) {
    if (!tz) return null;
    const k = tz.toUpperCase().replace(/\s/g, "");
    if (k in TZ) return TZ[k];
    const m = k.match(/^(UTC|GMT)([+-−])(\d{1,2})(?::?(\d{2}))?$/);
    if (m) return (m[2] === "+" ? 1 : -1) * (Number(m[3]) + (Number(m[4] || 0) / 60));
    return null;
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
    if (d) return startOf(d) + DAY < now;
    return e.year < new Date().getFullYear();
  };
  const fmt = d => d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  function fmtRange(e) {
    if (!e.start) return "Not announced";
    if (!e.end || e.end === e.start) return fmt(e.start);
    const a = new Date(e.start + "T00:00:00"), b = new Date(e.end + "T00:00:00");
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear())
      return `${a.getDate()}–${b.getDate()} ${b.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
    return `${fmt(e.start)} – ${fmt(e.end)}`;
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
    const d2 = `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}`;
    const s = series[e.series] || {};
    const p = new URLSearchParams({ action: "TEMPLATE", text: `${e.name} paper deadline`, dates: `${d}/${d2}`,
      details: `${s.full || ""}\n${e.url || ""}` });
    return "https://calendar.google.com/calendar/render?" + p;
  }
  function repoUrl() {
    const cfg = (window.TRACKER_CONFIG || {}).repo;
    if (cfg) return cfg.replace(/\/$/, "");
    const host = location.hostname, m = host.match(/^([^.]+)\.github\.io$/);
    if (!m) return "";
    const first = location.pathname.split("/").filter(Boolean)[0];
    return first && !first.includes(".") ? `https://github.com/${m[1]}/${first}` : `https://github.com/${m[1]}/${host}`;
  }
  const join = () => editions.map(e => ({ ...e, s: series[e.series] || { name: e.series, full: "", category: "eda" } }));

  // ---------- rendering ----------
  function renderHealth() {
    const el = $("#health");
    if (!meta.last_run) { el.innerHTML = `<span class="dot"></span>Waiting for the first tracker run`; return; }
    const hours = (Date.now() - new Date(meta.last_run).getTime()) / 36e5;
    const stale = hours > 50;
    el.innerHTML = `<span class="dot ${stale ? "stale" : "ok"}"></span>` +
      (stale ? `Tracker hasn't run since <b>${ago(meta.last_run)}</b>. Dates may be out of date.`
             : `Last checked <b>${ago(meta.last_run)}</b>, tracking ${meta.tracked_series || Object.keys(series).length} conferences`);
  }

  function renderHero() {
    const now = Date.now();
    const open = join().filter(e => ["open", "soon"].includes(status(e, now))).sort((a, b) => deadlineMs(a) - deadlineMs(b));
    const next = open[0];
    if (!next) { $("#hero").innerHTML = `<div><div class="lead">No open deadlines right now.</div></div>`; return; }
    const t = left(deadlineMs(next) - now);
    const after = open.slice(1, 4).map(e => `${esc(e.name)} (${fmt(e.deadline)})`).join(", ");
    $("#hero").innerHTML = `
      <div>
        <div class="lead">Next paper deadline</div>
        <div class="name">${esc(next.name)}</div>
        <div class="meta">Due ${fmt(next.deadline)}${next.deadline_tz ? ", 23:59 " + esc(next.deadline_tz) : ""}. Conference ${fmtRange(next)}${next.location ? ", " + esc(next.location) : ""}.</div>
        ${after ? `<div class="after">Then: ${after}</div>` : ""}
      </div>
      <div class="clock" role="timer" aria-label="${t.d} days ${t.h} hours left">
        <div><span>${t.d}</span><small>days</small></div>
        <div><span>${pad(t.h)}</span><small>hours</small></div>
        <div><span>${pad(t.m)}</span><small>min</small></div>
        <div><span>${pad(t.s)}</span><small>sec</small></div>
      </div>`;
  }

  function renderTimeline() {
    const W = 1000, H = 190, padL = 10, padR = 10, base = 150, hi = 128;
    const now = new Date();
    const t0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const t1 = new Date(now.getFullYear(), now.getMonth() + 10, 1).getTime();
    const x = t => padL + (t - t0) / (t1 - t0) * (W - padL - padR);
    let wave = `M${x(t0)},${base}`, ticks = "";
    for (let i = 0; i < 10; i++) {
      const a = new Date(now.getFullYear(), now.getMonth() + i, 1), b = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const y = i % 2 ? base : hi;
      wave += ` L${x(a.getTime())},${y} L${x(b.getTime())},${y}`;
      ticks += `<text x="${(x(a.getTime()) + x(b.getTime())) / 2}" y="${base + 22}" text-anchor="middle" font-size="13" fill="#5C6778">${a.toLocaleDateString(undefined, { month: "short" })}${a.getMonth() === 0 ? " " + a.getFullYear() : ""}</text>`;
    }
    const items = join().filter(e => e.deadline && startOf(e.deadline) >= t0 && startOf(e.deadline) < t1)
      .sort((a, b) => startOf(a.deadline) - startOf(b.deadline));
    const lanes = [-1e9, -1e9, -1e9, -1e9];
    let marks = "";
    items.forEach(e => {
      const xx = x(deadlineMs(e)), st = status(e);
      let lane = lanes.findIndex(l => xx - l > 92);
      if (lane < 0) lane = lanes.indexOf(Math.min(...lanes));
      lanes[lane] = xx;
      const ly = 20 + lane * 24, col = st === "closed" ? "#9AA3AF" : st === "soon" ? "#B8860B" : "#0B7D5E";
      marks += `<line x1="${xx}" y1="${ly + 4}" x2="${xx}" y2="${base}" stroke="${col}" stroke-width="2"/>
        <circle cx="${xx}" cy="${ly + 4}" r="3.5" fill="${col}"/>
        <text x="${xx + 6}" y="${ly + 8}" font-size="13" font-weight="650" fill="${st === "closed" ? "#8A93A0" : "#18202C"}">${esc(e.s.name)}</text>`;
    });
    const nx = x(now.getTime());
    $("#timeline").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${items.length} deadlines in the next ten months">
      <path d="${wave}" fill="none" stroke="#2742C9" stroke-width="2" opacity=".35"/>${ticks}${marks}
      <line x1="${nx}" y1="10" x2="${nx}" y2="${base + 6}" stroke="#18202C" stroke-dasharray="4 3"/>
      <text x="${nx}" y="${base + 40}" text-anchor="middle" font-size="12" fill="#18202C">today</text></svg>`;
  }

  function renderChanges() {
    const label = { extended: "Extended", announced: "Announced", "new-edition": "New edition", changed: "Changed" };
    const list = changes.filter(c => c.kind !== "note").slice(-15).reverse();
    $("#changes").innerHTML = list.length ? list.map(c =>
      `<li><time>${fmt(c.date)}</time><span class="kind ${esc(c.kind)}">${label[c.kind] || esc(c.kind)}</span>${esc(c.message)}${c.source ? ` <a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : ""}</li>`
    ).join("") : `<li>No changes yet. Extensions and newly announced deadlines will appear here as the bot finds them.</li>`;
  }

  function renderList() {
    const q = $("#q").value.trim().toLowerCase(), cat = $("#catSel").value, sort = $("#sortSel").value;
    const now = Date.now(), order = { soon: 0, open: 1, tba: 2, closed: 3 };
    let list = join().filter(e => {
      const st = status(e, now);
      if (view === "open" && !["open", "soon"].includes(st)) return false;
      if (view === "upcoming" && held(e, now)) return false;
      if (cat && e.s.category !== cat) return false;
      if (q && !`${e.name} ${e.s.full} ${e.s.focus} ${e.location} ${e.s.org}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const confKey = e => startOf(e.start) || new Date(e.year, 11, 31).getTime();
    list.sort(sort === "conf" ? (a, b) => confKey(a) - confKey(b) : (a, b) => {
      const sa = status(a, now), sb = status(b, now);
      if (order[sa] !== order[sb]) return order[sa] - order[sb];
      if (sa === "open" || sa === "soon") return deadlineMs(a) - deadlineMs(b);
      return confKey(a) - confKey(b);
    });
    if (!list.length) { $("#list").innerHTML = `<div class="empty">No conferences match. Clear the search or choose another category.</div>`; return; }
    const lab = { open: "Open", soon: "Closing soon", closed: "Closed", tba: "Not announced" };
    const repo = repoUrl();
    $("#list").innerHTML = `<div class="row headrow"><div>Conference</div><div>Conference dates</div><div>Location</div><div>Paper deadline</div><div>Links</div></div>` +
      list.map(e => {
        const st = status(e, now);
        const fix = repo ? `${repo}/issues/new?template=correction.yml&title=${encodeURIComponent("Correction: " + e.name)}` : "";
        return `<div class="row ${st === "closed" ? "closed" : ""}">
          <div class="c1"><div class="cname">${esc(e.name)}</div><div class="cfull">${esc(e.s.full)}</div>
            <span class="tier ${e.s.category === "t1" ? "t1" : ""}">${CAT[e.s.category] || ""}</span></div>
          <div><div class="cell-l">Dates</div>${fmtRange(e)}</div>
          <div><div class="cell-l">Location</div>${esc(e.location) || "Not announced"}</div>
          <div><div class="cell-l">Deadline</div>
            <div class="dl">${e.deadline ? fmt(e.deadline) : "TBA"}${e.deadline && e.deadline_tz ? `<span class="tz">${esc(e.deadline_tz)}</span>` : ""}</div>
            <span class="badge b-${st}">${lab[st]}</span>
            ${["open", "soon"].includes(st) ? `<div class="count" data-e="${esc(e.id)}"></div>` : ""}
            ${st === "tba" && e.s.typical ? `<div class="hint">${esc(e.s.typical)}</div>` : ""}</div>
          <div class="c5 acts">
            <a href="${esc(e.url || e.s.url)}" target="_blank" rel="noopener">Website</a>
            ${["open", "soon"].includes(st) ? `<a href="${gcal(e)}" target="_blank" rel="noopener">Add to calendar</a>` : ""}
            ${fix ? `<a href="${fix}" target="_blank" rel="noopener">Report a wrong date</a>` : ""}
          </div>
          <div class="meta-line">
            <span class="v-${esc(e.confidence)}">${VERIFY[e.confidence] || esc(e.confidence)}</span>
            <span>Checked ${ago(e.last_checked)}</span>
            ${e.source ? `<a href="${esc(e.source)}" target="_blank" rel="noopener">source</a>` : ""}
            ${e.note ? `<span class="note">${esc(e.note)}</span>` : ""}
          </div>
        </div>`;
      }).join("");
    tick();
  }

  function tick() {
    const now = Date.now(), byId = Object.fromEntries(editions.map(e => [e.id, e]));
    document.querySelectorAll("[data-e]").forEach(el => {
      const e = byId[el.dataset.e]; if (!e) return;
      const t = left(deadlineMs(e) - now);
      el.textContent = t.d > 0 ? `${t.d}d ${pad(t.h)}h ${pad(t.m)}m left` : `${pad(t.h)}:${pad(t.m)}:${pad(t.s)} left`;
    });
  }

  function renderAll() { renderHealth(); renderHero(); renderTimeline(); renderChanges(); renderList(); }

  // ---------- data ----------
  async function getJSON(path, fallback) {
    try {
      const r = await fetch(`${path}?v=${Math.floor(Date.now() / 6e5)}`, { cache: "no-cache" });
      return r.ok ? await r.json() : fallback;
    } catch { return fallback; }
  }
  async function load() {
    const [s, e, c, m] = await Promise.all([
      getJSON("data/series.json", []), getJSON("data/editions.json", []),
      getJSON("data/changelog.json", []), getJSON("data/meta.json", {}),
    ]);
    series = Object.fromEntries(s.map(x => [x.id, x]));
    editions = e; changes = c; meta = m;
    if (!editions.length) { $("#list").innerHTML = `<div class="empty">Couldn't load the conference data. Refresh the page to try again.</div>`; return; }
    renderAll();
  }

  // ---------- wiring ----------
  document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
    view = b.dataset.view;
    document.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    renderList();
  }));
  ["#q", "#catSel", "#sortSel"].forEach(s => $(s).addEventListener("input", renderList));

  const icsAbs = new URL("deadlines.ics", location.href);
  $("#subCal").href = icsAbs.href.replace(/^https?:/, "webcal:");
  $("#subGcal").href = "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(icsAbs.href.replace(/^https?:/, "webcal:"));
  const repo = repoUrl();
  if (repo) $("#repoLinks").innerHTML = `Missing a conference? <a href="${repo}/issues/new?template=new-conference.yml" target="_blank" rel="noopener">Suggest one</a>. See <a href="${repo}/commits/main/docs/data/editions.json" target="_blank" rel="noopener">every data change</a> or the <a href="${repo}" target="_blank" rel="noopener">source code</a>.`;

  load();
  setInterval(() => { renderHero(); tick(); }, 1000);
  setInterval(() => { renderHealth(); renderList(); renderTimeline(); }, 60e3);   // status flips at deadlines
  setInterval(load, 30 * 60e3);                                                   // pick up new bot data
})();
