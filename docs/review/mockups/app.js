/* Crabby Web UI review mockup — behaviour.
 * Generated into web.html by build.py; the element list comes from docs/review/WEB.md, so this
 * file never invents an element and never hides one. Nothing here talks to a network or stores
 * anything outside this browser's localStorage.
 */
(function () {
  "use strict";

  var ROWS = (window.CRABBY_DATA || []).map(function (r) {
    r.text = r.content || r.items || r.element || "";
    r.title = r.region_title || r.region;
    return r;
  });
  var BY_ID = {};
  ROWS.forEach(function (r) { BY_ID[r.id] = r; });

  var TABS = [
    { tpl: "chat", label: "Chat" },
    { tpl: "tasks", label: "Tasks" },
    { tpl: "detail", label: "Task detail" },
    { tpl: "approvals", label: "Approvals" },
    { tpl: "settings", label: "Providers · models · tools" },
    { tpl: "panels", label: "Memory · extensions · logs" },
    { tpl: "states", label: "States & first run" },
    { tpl: "inventory", label: "Inventory sheet" }
  ];

  var KEY = "crabby-web-review-v1";
  var review = load();

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(review)); } catch (e) { /* private mode: notes live only in this tab */ }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var stage = document.getElementById("stage");
  var tabsEl = document.getElementById("tabs");
  var screensEl = document.getElementById("screens");

  /* ---------- build screens from the markup templates ---------- */
  TABS.forEach(function (tab, i) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.textContent = tab.label;
    btn.dataset.tab = tab.tpl;
    btn.setAttribute("aria-selected", i === 0 ? "true" : "false");
    tabsEl.appendChild(btn);

    var screen = document.createElement("section");
    screen.className = "screen";
    screen.dataset.tab = tab.tpl;
    screen.setAttribute("role", "tabpanel");
    if (i === 0) screen.dataset.active = "true";

    if (tab.tpl === "inventory") screen.appendChild(inventorySheet());
    else {
      var src = document.getElementById("tpl-" + tab.tpl);
      if (src) {
        screen.innerHTML = src.textContent;
        src.remove();  // the template is markup text, not content: keep it out of the a11y tree
      }
    }
    screensEl.appendChild(screen);
  });

  function inventorySheet() {
    // Every row of WEB.md appears here, even ones with no distinct visual, so the mockup can
    // never quietly drop an element. Rows also drawn on a screen say so.
    var wrap = document.createElement("div");
    var byRegion = {};
    ROWS.forEach(function (r) { (byRegion[r.region] = byRegion[r.region] || []).push(r); });
    var order = Object.keys(byRegion).sort(function (a, b) {
      return a.length === b.length ? (a < b ? -1 : 1) : a.length - b.length;
    });
    var html = '<p class="note" style="margin:0;padding:8px 12px">All ' + ROWS.length +
      " rows from <code>docs/review/WEB.md</code>, in region order. Anything here can be reviewed " +
      "exactly like a rendered element — the drawer is the same.</p>";
    order.forEach(function (region) {
      var rows = byRegion[region];
      html += '<div class="bar" style="justify-content:space-between"><strong>' + esc(region) +
        " — " + esc(rows[0].region_title || "") + '</strong><span class="note">' + rows.length + " element" +
        (rows.length === 1 ? "" : "s") + "</span></div>";
      html += '<div class="list">' + rows.map(function (r) {
        var drawn = r.id && r.placed ? "also on " + esc(r.placed) : "described, not drawn";
        return '<div class="row" data-el="' + esc(r.id) + '" data-auto="1">' +
          '<div class="actions"><span class="mono note">' + esc(r.id) + "</span>" +
          "<strong>" + esc(r.element) + "</strong><span class='note'>· " + drawn + "</span></div>" +
          '<div class="msg">' + esc(r.text) + "</div>" +
          (r.sizes ? '<span class="note">sizes: ' + esc(r.sizes) + "</span>" : "") +
          (r.behavior ? '<span class="note">behavior: ' + esc(r.behavior) + "</span>" : "") +
          (r.placement ? '<span class="note">placement: ' + esc(r.placement) + "</span>" : "") +
          "</div>";
      }).join("") + "</div>";
    });
    wrap.innerHTML = html;
    return wrap;
  }

  /* ---------- attach review affordances to every element ---------- */
  var placed = {};
  // The inventory sheet holds one card per row, so those cards carry data-auto: simulated state
  // changes and bar layout must never reach them, or "what the mockup shows" stops matching
  // "what the inventory says".
  function instances(id) {
    return (placed[id] || []).filter(function (el) { return !el.dataset.auto; });
  }
  function decorate(el) {
    if (el.dataset.decorated) return;
    el.dataset.decorated = "1";
    var id = el.dataset.el;
    el.classList.add("el");
    if (!el.querySelector(":scope > .el-label")) {
      var tag = document.createElement("span");
      tag.className = "el-label";
      tag.textContent = id;
      el.appendChild(tag);
    }
    (placed[id] = placed[id] || []).push(el);
    var row = BY_ID[id];
    if (!row) { el.dataset.status = "UNKNOWN"; return; }
    var tab = el.closest(".screen") ? el.closest(".screen").dataset.tab : "";
    if (tab && tab !== "inventory" && !row.placed) row.placed = tab;
    el.setAttribute("title", row.element + " — " + (row.text || ""));
  }
  function decorateAll(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll("[data-el]"), decorate);
  }
  decorateAll();

  /* ---------- status painting ---------- */
  function statusOf(id) { return (review[id] && review[id].status) || (BY_ID[id] && BY_ID[id].status) || "PROPOSED"; }
  function paint() {
    Object.keys(placed).forEach(function (id) {
      placed[id].forEach(function (el) {
        el.dataset.status = statusOf(id);
        var lab = el.querySelector(":scope > .el-label");
        if (lab) {
          var edited = review[id] && (review[id].status || review[id].note);
          lab.textContent = id + (edited ? " •" : "");
        }
      });
    });
    var counts = {};
    ROWS.forEach(function (r) { var s = statusOf(r.id); counts[s] = (counts[s] || 0) + 1; });
    document.getElementById("counts").innerHTML = ["ACCEPTED", "EDIT", "CUT", "?", "PROPOSED"].map(function (k) {
      return '<span class="chip" data-tone="' + ({ ACCEPTED: "ok", EDIT: "warn", "?": "info", CUT: "err" }[k] || "") + '">' +
        k + " " + (counts[k] || 0) + "</span>";
    }).join("") + '<span class="note">' + ROWS.length + " rows</span>";
    var done = ROWS.filter(function (r) { return statusOf(r.id) !== "PROPOSED"; }).length;
    document.getElementById("d-progress").textContent = "reviewed " + done + " of " + ROWS.length;
  }

  /* ---------- selection + drawer ---------- */
  var current = null;
  function select(id) {
    current = id;
    Array.prototype.forEach.call(document.querySelectorAll('.el[data-selected="true"]'), function (el) {
      el.dataset.selected = "false";
    });
    (placed[id] || []).forEach(function (el) { el.dataset.selected = "true"; });
    var r = BY_ID[id];
    var empty = document.getElementById("d-empty"), form = document.getElementById("d-form");
    if (!r) {
      empty.textContent = id + " is drawn in the mockup but has no row in docs/review/WEB.md. That is a defect in the " +
        "inventory or the mockup — it should be reported, not approved.";
      empty.hidden = false; form.hidden = true; return;
    }
    empty.hidden = true; form.hidden = false;
    document.getElementById("d-id").textContent = r.id;
    document.getElementById("d-region").textContent = r.region + " — " + (r.region_title || "");
    document.getElementById("d-element").textContent = r.element;
    document.getElementById("d-content").textContent = r.text || "—";
    document.getElementById("d-sizes").textContent = r.sizes || "no size claim yet (fill this in — the 360px case is the binding one)";
    document.getElementById("d-behavior").textContent = [r.behavior, r.placement ? "placement: " + r.placement : ""].filter(Boolean).join(" · ") || "—";
    var st = document.getElementById("d-status");
    st.value = statusOf(id);
    document.getElementById("d-note").value = (review[id] && review[id].note) || "";
    document.getElementById("d-row").textContent = rowMarkdown(id);
    var tier = document.getElementById("d-tier");
    var m = /T[0-3]/.exec(r.text + " " + r.behavior);
    tier.hidden = !m; if (m) { tier.textContent = m[0]; tier.dataset.tier = m[0]; }
  }

  function rowMarkdown(id) {
    var r = BY_ID[id], rv = review[id] || {};
    var status = rv.status || r.status || "PROPOSED";
    var cells = r.raw ? r.raw.split("|").slice(1, -1).map(function (c) { return c.trim(); }) : null;
    if (!cells || cells.length < 2) {
      cells = [id].concat((r.cols || []).map(function (c) {
        return c === "status" ? status : (r[c] === undefined ? "" : r[c]);
      }));
    } else {
      cells[cells.length - 1] = status;
    }
    if (rv.note) cells[cells.length - 1] = status + ' _(owner: "' + rv.note.replace(/"/g, '"') + '")_';
    return "| " + cells.join(" | ") + " |";
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-el]");
    if (!el) return;
    if (stage.dataset.picking !== "on" && !ev.altKey) return;
    if (el.closest(".drawer")) return;
    // no preventDefault: the mock's own controls (details, checkboxes) must still work, a
    // review click is additive, not a replacement.
    select(el.dataset.el);
  });

  document.addEventListener("change", function (ev) {
    if (ev.target.id === "d-status") {
      if (!current) return;
      review[current] = review[current] || {};
      review[current].status = ev.target.value;
      if (!review[current].note) delete review[current].note;
      if (!Object.keys(review[current]).length) delete review[current];
      save(); paint(); document.getElementById("d-row").textContent = rowMarkdown(current);
    }
  });
  document.getElementById("d-note").addEventListener("input", function (ev) {
    if (!current) return;
    review[current] = review[current] || {};
    review[current].note = ev.target.value;
    if (!ev.target.value && !review[current].status) delete review[current];
    save(); paint(); document.getElementById("d-row").textContent = rowMarkdown(current);
  });

  document.getElementById("d-next").addEventListener("click", function () {
    var idx = current ? ROWS.findIndex(function (r) { return r.id === current; }) : -1;
    for (var i = 1; i <= ROWS.length; i++) {
      var r = ROWS[(idx + i) % ROWS.length];
      if (statusOf(r.id) === "PROPOSED") {
        reveal(r); select(r.id); return;
      }
    }
    document.getElementById("d-progress").textContent = "every row has a decision — copy the review out";
  });
  function reveal(r) {
    var els = placed[r.id] || [];
    if (!els.length) return;
    var screen = els[0].closest(".screen");
    if (screen) activate(screen.dataset.tab);
    if (els[0].scrollIntoView) els[0].scrollIntoView({ block: "center", inline: "nearest" });
  }

  function copy(text, done) {
    var ta, ok = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
    } else fallback();
    function fallback() {
      try {
        ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) { ok = false; }
      done(ok);
    }
  }
  function showInDrawer(text, label) {
    var box = document.getElementById("d-row");
    box.textContent = text;
    document.getElementById("d-form").hidden = false;
    document.getElementById("d-empty").hidden = true;
    if (box.scrollIntoView) box.scrollIntoView({ block: "nearest" });
    if (label) document.getElementById("d-progress").textContent = label;
  }
  document.getElementById("d-copy").addEventListener("click", function () {
    if (!current) return;
    copy(rowMarkdown(current), function (ok) {
      document.getElementById("d-progress").textContent = ok ? "row copied — paste it over the old row in WEB.md" : "clipboard blocked; the row is shown below to select";
      if (!ok) showInDrawer(rowMarkdown(current));
    });
  });

  function exportReview() {
    var changed = ROWS.filter(function (r) {
      var rv = review[r.id];
      return rv && (rv.status || rv.note);
    });
    if (!changed.length) return "No changes yet. Tap an element, set a status, or write a note — this button then gives paste-ready rows.";
    var lines = ["", "Owner review pass — " + changed.length + " of " + ROWS.length +
      " rows changed. Each block below replaces the row of the same ID in `docs/review/WEB.md`.", ""];
    var byRegion = {};
    changed.forEach(function (r) { (byRegion[r.region] = byRegion[r.region] || []).push(r); });
    Object.keys(byRegion).forEach(function (region) {
      lines.push("### " + region + " — " + (byRegion[region][0].region_title || ""));
      lines.push("");
      byRegion[region].forEach(function (r) { lines.push(rowMarkdown(r.id)); });
      lines.push("");
    });
    var questions = changed.filter(function (r) { return statusOf(r.id) === "?"; });
    if (questions.length) {
      lines.push("### Blocking questions");
      questions.forEach(function (r) { lines.push("- " + r.id + " (" + r.element + "): " + ((review[r.id] || {}).note || "no note given")); });
      lines.push("");
    }
    return lines.join("\n");
  }
  document.getElementById("export").addEventListener("click", function () {
    var text = exportReview();
    copy(text, function (ok) {
      if (!ok) showInDrawer(text, "clipboard blocked — select the text below and copy it manually");
      else document.getElementById("d-progress").textContent = "review copied (" + text.split("\n").length + " lines)";
    });
  });
  document.getElementById("download").addEventListener("click", function () {
    var blob = new Blob([exportReview() + "\n"], { type: "text/markdown" });
    var a2 = document.createElement("a");
    a2.href = URL.createObjectURL(blob);
    a2.download = "crabby-web-review.md";
    document.body.appendChild(a2); a2.click();
    setTimeout(function () { URL.revokeObjectURL(a2.href); a2.remove(); }, 500);
  });
  document.getElementById("reset").addEventListener("click", function () {
    if (!confirm("Discard your local statuses and notes? WEB.md itself is untouched.")) return;
    review = {}; save(); paint();
    if (current) select(current);
  });

  /* ---------- viewport / theme / density ---------- */
  function seg(id, attr, after) {
    var box = document.getElementById(id);
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest("button");
      if (!b) return;
      Array.prototype.forEach.call(box.querySelectorAll("button"), function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      after(b.dataset[attr]);
    });
  }
  seg("viewport", "v", function (v) { stage.dataset.viewport = v; layoutBar(); });
  seg("theme", "t", function (t) { document.documentElement.dataset.theme = t; });
  seg("density", "d", function (d) { document.documentElement.dataset.density = d; });
  document.getElementById("picking").addEventListener("change", function (ev) {
    stage.dataset.picking = ev.target.checked ? "on" : "off";
  });
  document.getElementById("labels").addEventListener("change", function (ev) {
    stage.dataset.labels = ev.target.checked ? "on" : "off";
  });
  ["sim-vault", "sim-offline", "sim-tunnel", "sim-firstrun"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", function () { layoutBar(); runStates(); });
  });

  function activate(name) {
    Array.prototype.forEach.call(tabsEl.querySelectorAll("button"), function (b) {
      b.setAttribute("aria-selected", String(b.dataset.tab === name));
    });
    Array.prototype.forEach.call(screensEl.querySelectorAll(".screen"), function (s) {
      s.dataset.active = String(s.dataset.tab === name);
    });
  }
  tabsEl.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[role=tab]");
    if (b) activate(b.dataset.tab);
  });

  /* ---------- W1-A: the bar at 360px, live ---------- */
  var ESCAPERS = { "W1-07": "sim-vault", "W1-04": "sim-offline" };
  function inlineAt360() {
    var keep = ["W1-01", "W1-02", "W1-03", "W1-05", "W1-06"];
    Object.keys(ESCAPERS).forEach(function (id) {
      if (document.getElementById(ESCAPERS[id]).checked) keep.push(id);
    });
    return keep;
  }
  function layoutBar() {
    var narrow = stage.dataset.viewport === "phone";
    var keep = inlineAt360();
    var collapsed = [];
    ["W1-01", "W1-02", "W1-03", "W1-04", "W1-05", "W1-06", "W1-07", "W1-08", "W1-09"].forEach(function (id) {
      var hid = narrow && keep.indexOf(id) < 0;
      instances(id).forEach(function (el) { el.hidden = hid; });
      if (hid) collapsed.push(id);
    });
    var btn = document.getElementById("more-btn");
    if (btn) btn.hidden = !narrow;
    var sheet = document.getElementById("more-sheet");
    if (sheet) {
      var items = collapsed.filter(function (v, i, arr) { return arr.indexOf(v) === i; }).map(function (id) {
        return '<div class="row" data-el="' + id + '"><strong>' + esc(BY_ID[id] ? BY_ID[id].element : id) + "</strong>" +
          '<span class="note">' + esc(BY_ID[id] ? BY_ID[id].text : "") + "</span></div>";
      });
      var escaped = ["W1-04", "W1-07"].filter(function (id) { return keep.indexOf(id) >= 0; });
      if (narrow && escaped.length) items.push('<div class="row"><span class="note note--warn">forced out of this sheet into the bar: ' +
        escaped.join(", ") + " — the state itself changes what you can trust on screen</span></div>");
      sheet.innerHTML = items.join("") || '<div class="row"><span class="note">nothing is collapsed at this width</span></div>';
      decorateAll(sheet);
    }
    var fr = document.getElementById("sim-firstrun").checked;
    instances("W-O1").forEach(function (el) { el.hidden = !fr; });
  }
  var moreBtn = document.getElementById("more-btn");
  if (moreBtn) {
    var sheet = document.createElement("div");
    sheet.id = "more-sheet";
    sheet.className = "list";
    sheet.dataset.el = "W1-11";
    sheet.hidden = true;
    moreBtn.parentNode.appendChild(sheet);
    moreBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      sheet.hidden = !sheet.hidden;
    });
  }
  function runStates() {
    var vault = document.getElementById("sim-vault").checked;
    var offline = document.getElementById("sim-offline").checked;
    var tunnel = document.getElementById("sim-tunnel").checked;
    instances("W1-06").forEach(function (el) {
      el.dataset.tone = tunnel ? "tunnel" : "off";
      el.innerHTML = '<span class="chip__dot"></span>tunnel: ' + (tunnel ? "k7x-abcd" : "off") + '<span class="el-label">W1-06</span>';
    });
    instances("W1-07").forEach(function (el) {
      el.dataset.tone = vault ? "err" : "ok";
      el.innerHTML = '<span class="chip__dot"></span>vault: ' + (vault ? "locked" : "unlocked") + '<span class="el-label">W1-07</span>';
    });
    instances("W1-04").forEach(function (el) {
      el.dataset.tone = offline ? "err" : "info";
      el.innerHTML = '<span class="chip__dot"></span>' + (offline ? "offline · last seen 21:44" : "reconnecting") + '<span class="el-label">W1-04</span>';
    });
    instances("W6-13").forEach(function (el) { el.textContent = offline ? "paused — 2 events deferred" : "live tail"; });
    var banner = document.getElementById("tunnel-banner");
    if (!banner) {
      banner = document.createElement("p");
      banner.id = "tunnel-banner";
      banner.className = "note el";
      banner.dataset.el = "W1-06";
      banner.style.cssText = "margin:0;padding:6px 12px;background:color-mix(in srgb,var(--tunnel-on) 14%,transparent);border-bottom:1px solid var(--line)";
      banner.innerHTML = "This page is reachable through the tunnel (<code>k7x-abcd</code>). Anything you approve here runs on the phone. <span class=\"el-label\">W1-06</span>";
      screensEl.parentNode.insertBefore(banner, screensEl);
      decorate(banner);
    }
    decorateAll(banner.parentNode);
    banner.hidden = !tunnel;
  }

  /* keyboard: j/k walk the elements of the active screen, a/d/x/? set decisions */
  document.addEventListener("keydown", function (ev) {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (ev.key === "Escape") { Array.prototype.forEach.call(document.querySelectorAll('.el[data-selected="true"]'), function (el) { el.dataset.selected = "false"; }); return; }
    var list = Array.prototype.filter.call(
      document.querySelectorAll('.screen[data-active="true"] [data-el]'),
      function (el) { return !el.hidden && el.offsetParent; });
    var idx = current ? list.findIndex(function (el) { return el.dataset.el === current; }) : -1;
    if (ev.key === "j" || ev.key === "k") {
      ev.preventDefault();
      var nxt = list[Math.max(0, Math.min(list.length - 1, idx + (ev.key === "j" ? 1 : -1)))];
      if (nxt) { select(nxt.dataset.el); if (nxt.scrollIntoView) nxt.scrollIntoView({ block: "nearest" }); }
    } else if (current && "adx".indexOf(ev.key) >= 0) {
      var map = { a: "ACCEPTED", d: "EDIT", x: "CUT" };
      review[current] = review[current] || {};
      review[current].status = map[ev.key];
      save(); paint(); document.getElementById("d-row").textContent = rowMarkdown(current);
      var next = list[idx + 1]; if (next) { select(next.dataset.el); if (next.scrollIntoView) next.scrollIntoView({ block: "nearest" }); }
    } else if (current && ev.key === "?") {
      review[current] = review[current] || {};
      review[current].status = "?";
      save(); paint();
      document.getElementById("d-note").focus();
    }
  });

  paint(); layoutBar(); runStates();
  if (ROWS.length) select(ROWS[0].id);
})();
