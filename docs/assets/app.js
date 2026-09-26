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


  // ---------- deadline diagram: clock waveform with rising edges at each deadline ----------
  function renderDiagram() {
    const W = 1200, padL = 16, padR = 16, MONTHS = 10;
    const now = new Date(), nowMs = now.getTime();
    const t0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const t1 = new Date(now.getFullYear(), now.getMonth() + MONTHS, 1).getTime();
    const x = t => padL + (t - t0) / (t1 - t0) * (W - padL - padR);
    const items = join().filter(e => e.deadline && deadlineMs(e) >= t0 && deadlineMs(e) < t1)
      .sort((a, b) => deadlineMs(a) - deadlineMs(b));

    // label boxes: name on line 1, date + distance on line 2; width from text length
    const CH_NAME = 9.2, CH_SUB = 7.6, BOX_H = 44, GAP = 10;
    const boxes = items.map(e => {
      const st = status(e, nowMs), days = Math.ceil((deadlineMs(e) - nowMs) / DAY);
      const name = e.s.name;
      const when = st === "closed" ? `${fmtShort(e.deadline)}, closed` :
        days <= 0 ? `${fmtShort(e.deadline)}, today` : `${fmtShort(e.deadline)}, in ${days} day${days === 1 ? "" : "s"}`;
      const w = Math.max(name.length * CH_NAME, when.length * CH_SUB) + 20;
      const xx = x(deadlineMs(e));
      const flip = xx + w > W - padR;              // anchor label to the left of the edge near the right end
      return { e, st, name, when, w, xx, bx: flip ? xx - w : xx, flip };
    });
    // Lane packing, lane 0 closest to the waveform. Rules:
    //  - boxes in the same lane must not overlap
    //  - a box must never cover another deadline's stem, so any deadline whose edge
    //    falls under a box has to sit in a lower lane (a staircase)
    const placed = [];
    const covers = (b, xx) => xx >= b.bx - 4 && xx <= b.bx + b.w + 4;
    for (let i = boxes.length - 1; i >= 0; i--) {             // right to left
      const b = boxes[i];
      let min = 0, max = Infinity;
      placed.forEach(p => {
        if (covers(b, p.xx)) min = Math.max(min, p.lane + 1);  // p's stem is under b: b goes above p
        if (covers(p, b.xx)) max = Math.min(max, p.lane - 1);  // b's stem is under p: b goes below p
      });
      const free = L => !placed.some(p => p.lane === L && b.bx < p.bx + p.w + GAP && p.bx < b.bx + b.w + GAP);
      let lane = min;
      while (!free(lane) && lane <= max) lane++;
      if (!free(lane)) { lane = min; while (!free(lane)) lane++; }   // constraint impossible: just avoid overlap
      b.lane = lane;
      placed.push(b);
    }
    const lanes = Math.max(1, ...boxes.map(b => b.lane + 1));
    const top = 16, laneH = BOX_H + 12;
    const hi = top + lanes * laneH + 18, lo = hi + 34, H = lo + 58;

    // waveform: high on even months, low on odd months
    let wave = `M${x(t0)},${lo}`, months = "", grid = "";
    for (let i = 0; i < MONTHS; i++) {
      const a = new Date(now.getFullYear(), now.getMonth() + i, 1), b = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const xa = x(a.getTime()), xb = x(b.getTime()), y = i % 2 ? lo : hi;
      wave += ` L${xa},${y} L${xb},${y}`;
      const yr = a.getMonth() === 0 || i === 0 ? ` ${a.getFullYear()}` : "";
      months += `<text x="${(xa + xb) / 2}" y="${lo + 30}" text-anchor="middle" font-size="16" font-weight="700" fill="#2B3645">${a.toLocaleDateString(undefined, { month: "short" })}${yr}</text>`;
      if (i) grid += `<line x1="${xa}" y1="${top}" x2="${xa}" y2="${lo + 8}" stroke="#E3E8EE" stroke-width="1"/>`;
    }
    const nx = x(nowMs);
    const colour = { open: "#08694E", soon: "#C77700", closed: "#8E98A6" };
    const textCol = { open: "#0E1621", soon: "#0E1621", closed: "#56606E" };

    const stems = boxes.map(b => {
      const by = hi - 18 - (b.lane + 1) * laneH + 12, c = colour[b.st];
      return `<line x1="${b.xx}" y1="${by + BOX_H}" x2="${b.xx}" y2="${lo}" stroke="${c}" stroke-width="${b.st === "closed" ? 2 : 3}"/>
        <circle cx="${b.xx}" cy="${lo}" r="5" fill="${c}"/>`;
    }).join("");
    const marks = boxes.map(b => {
      const by = hi - 18 - (b.lane + 1) * laneH + 12, c = colour[b.st];
      const tx = b.bx + 10;
      return `<g class="dg-item" tabindex="0" role="link" data-id="${esc(b.e.id)}" aria-label="${esc(b.e.name)} paper deadline ${esc(b.when)}">
        <title>${esc(b.e.name)}: paper deadline ${fmt(b.e.deadline)}</title>
        <rect class="pill" x="${b.bx}" y="${by}" width="${b.w}" height="${BOX_H}" rx="6" fill="#fff" stroke="${c}" stroke-width="2"/>
        <rect x="${b.flip ? b.bx + b.w - 5 : b.bx}" y="${by}" width="5" height="${BOX_H}" rx="2" fill="${c}"/>
        <text x="${tx}" y="${by + 19}" font-size="16" font-weight="800" fill="${textCol[b.st]}">${esc(b.name)}</text>
        <text x="${tx}" y="${by + 36}" font-size="13.5" font-weight="600" fill="${b.st === "closed" ? "#56606E" : b.st === "soon" ? "#8A5300" : "#2B3645"}">${esc(b.when)}</text>
      </g>`;
    }).join("");

    $("#diagram").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${items.length} paper deadlines over the next ${MONTHS} months, relative to today">
      <rect x="${x(t0)}" y="${top - 6}" width="${Math.max(0, nx - x(t0))}" height="${lo - top + 14}" fill="#EEF1F5"/>
      ${grid}
      <path d="${wave}" fill="none" stroke="#1D38B0" stroke-width="3" stroke-linejoin="round" opacity=".55"/>
      ${months}
      <line x1="${nx}" y1="${top - 6}" x2="${nx}" y2="${lo + 8}" stroke="#C0251B" stroke-width="3"/>
      <rect x="${nx - 30}" y="${lo + 38}" width="60" height="22" rx="4" fill="#C0251B"/>
      <text x="${nx}" y="${lo + 54}" text-anchor="middle" font-size="13.5" font-weight="800" fill="#fff">Today</text>
      ${stems}${marks}
    </svg>`;
    if (!items.length) $("#diagram").innerHTML = `<div class="empty">No deadlines in the next ${MONTHS} months yet.</div>`;
  }

  function jumpTo(id) {
    if (layout !== "list") document.querySelector('[data-layout="list"]').click();
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
  function renderAll() { renderHealth(); renderHero(); renderChanges(); renderDiagram(); renderMain(); }

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
  $("#diagram").addEventListener("click", ev => { const g = ev.target.closest(".dg-item"); if (g) jumpTo(g.dataset.id); });
  $("#diagram").addEventListener("keydown", ev => {
    const g = ev.target.closest(".dg-item");
    if (g && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); jumpTo(g.dataset.id); }
  });

  const icsAbs = new URL("deadlines.ics", location.href);
  const webcal = icsAbs.href.replace(/^https?:/, "webcal:");
  $("#subCal").href = webcal;
  $("#subGcal").href = "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(webcal);
  const repo = repoUrl();
  if (repo) $("#repoLinks").innerHTML = `Missing a conference? <a href="${repo}/issues/new?template=new-conference.yml" target="_blank" rel="noopener">Suggest one</a>. See <a href="${repo}/commits/main/docs/data/editions.json" target="_blank" rel="noopener">every data change</a> or the <a href="${repo}" target="_blank" rel="noopener">source code</a>.`;

  load();
  setInterval(() => { renderHero(); tick(); }, 1000);
  setInterval(() => { renderHealth(); renderDiagram(); renderMain(); }, 60e3);
  setInterval(load, 30 * 60e3);
})();
