/* Crabby Web UI review mockup — behaviour.
 * Inlined into crabby-web-ui.html by build.py. The element list comes from docs/review/WEB.md, so this file
 * never invents an element and never hides one. No network, no storage outside localStorage.
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

  // One entry per screen of the app; the persistent status bar and nav wrap every screen, the way
  // they do in the real thing, so the review sees them in context instead of once.
  var SCREENS = [
    { tpl: "chat", label: "Chat" },
    { tpl: "sessions", label: "Sessions" },
    { tpl: "tasks", label: "Tasks" },
    { tpl: "detail", label: "Task detail" },
    { tpl: "approvals", label: "Approvals" },
    { tpl: "context", label: "Context" },
    { tpl: "memory", label: "Memory" },
    { tpl: "providers", label: "Providers" },
    { tpl: "models", label: "Models" },
    { tpl: "tools", label: "Tools" },
    { tpl: "extensions", label: "Extensions" },
    { tpl: "settings", label: "Settings" },
    { tpl: "access", label: "Access" },
    { tpl: "logs", label: "Logs" },
    { tpl: "onboarding", label: "First run" },
    { tpl: "states", label: "Overlays & states" },
    { tpl: "inventory", label: "Every row" }
  ];

  var KEY = "crabby-web-review-v1";
  var review = load();
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(review)); } catch (e) { /* private mode */ } }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var stage = document.getElementById("stage");
  var tabsEl = document.getElementById("tabs");
  var screensEl = document.getElementById("screens");
  var barTpl = document.getElementById("tpl-bar");
  var navTpl = document.getElementById("tpl-nav");

  SCREENS.forEach(function (scr, i) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.textContent = scr.label;
    btn.dataset.tab = scr.tpl;
    btn.setAttribute("aria-selected", i === 0 ? "true" : "false");
    tabsEl.appendChild(btn);

    var screen = document.createElement("section");
    screen.className = "screen";
    screen.dataset.tab = scr.tpl;
    screen.setAttribute("role", "tabpanel");
    if (i === 0) screen.dataset.active = "true";

    if (scr.tpl === "inventory") screen.appendChild(inventorySheet());
    else {
      var src = document.getElementById("tpl-" + scr.tpl);
      if (src) {
        var persistent = (barTpl ? barTpl.textContent : "") + '<p class="banner" data-el="W1-06" hidden>tunnel on</p>';
        screen.innerHTML = persistent + src.textContent + (navTpl ? navTpl.textContent : "");
        src.remove();  // templates are markup text, not content: keep them out of the a11y tree
      }
    }
    screensEl.appendChild(screen);
  });

  function inventorySheet() {
    // Every row of WEB.md appears here, even ones with no distinct visual, so the mockup can never
    // quietly drop an element. Rows drawn on a screen say which screen.
    var wrap = document.createElement("div");
    var byRegion = {};
    ROWS.forEach(function (r) { (byRegion[r.region] = byRegion[r.region] || []).push(r); });
    var order = Object.keys(byRegion).sort(function (a, b) {
      return a.length === b.length ? (a < b ? -1 : 1) : a.length - b.length;
    });
    var html = '<p class="note pad">All ' + ROWS.length + " rows from <code>docs/review/WEB.md</code>, in region order. " +
      "Anything here can be reviewed exactly like a rendered element — the drawer is the same.</p>";
    order.forEach(function (region) {
      var rows = byRegion[region];
      html += '<div class="bar"><strong>' + esc(region) + " — " + esc(rows[0].region_title || "") +
        '</strong><span class="spacer" style="flex:1"></span><span class="note">' + rows.length + " element" +
        (rows.length === 1 ? "" : "s") + "</span></div>";
      html += '<div class="list">' + rows.map(function (r) {
        return '<div class="row" data-el="' + esc(r.id) + '" data-auto="1">' +
          '<div class="actions"><span class="mono note">' + esc(r.id) + "</span>" +
          "<strong>" + esc(r.element) + "</strong>" +
          '<span class="note">· ' + (r.placed ? "drawn on: " + esc(r.placed) : "described, not drawn") + "</span></div>" +
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

  /* ---------- attach review affordances ---------- */
  var placed = {};
  function screenOf(el) {
    var s = el.closest(".screen");
    return s ? s.dataset.tab : "";
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
    var tab = screenOf(el);
    if (tab && tab !== "inventory" && !row.placed) row.placed = tab;
    el.setAttribute("title", row.element + " — " + (row.text || ""));
  }
  function decorateAll(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll("[data-el]"), decorate);
  }
  decorateAll();
  // The persistent bar and nav are the same element on every screen; count one instance per screen.
  function instances(id, screen) {
    return (placed[id] || []).filter(function (el) {
      return !el.dataset.auto && (!screen || screenOf(el) === screen);
    });
  }

  /* ---------- status ---------- */
  function statusOf(id) { return (review[id] && review[id].status) || (BY_ID[id] && BY_ID[id].status) || "PROPOSED"; }
  function paint() {
    Object.keys(placed).forEach(function (id) {
      placed[id].forEach(function (el) {
        el.dataset.status = statusOf(id);
        var lab = el.querySelector(":scope > .el-label");
        if (lab) lab.textContent = id + ((review[id] && (review[id].status || review[id].note)) ? " •" : "");
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

  /* ---------- drawer ---------- */
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
      empty.innerHTML = "<code>" + esc(id) + "</code> mockup-e ache, kintu <code>docs/review/WEB.md</code>-e tar row nei. " +
        "Eta inventory ba mockup er defect — accept na kore report korun.";
      empty.hidden = false; form.hidden = true; return;
    }
    empty.hidden = true; form.hidden = false;
    document.getElementById("d-id").textContent = r.id + " · " + r.element;
    document.getElementById("d-region").textContent = r.region + " — " + (r.region_title || "");
    document.getElementById("d-element").textContent = r.element;
    document.getElementById("d-content").textContent = r.text || "—";
    document.getElementById("d-sizes").textContent = r.sizes || "size claim nei — 360px case ta bhor e likhun";
    document.getElementById("d-behavior").textContent =
      [r.behavior, r.placement ? "placement: " + r.placement : ""].filter(Boolean).join(" · ") || "—";
    document.getElementById("d-status").value = statusOf(id);
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
    var goto = ev.target.closest("[data-goto]");
    if (goto) { ev.preventDefault(); activate(goto.dataset.goto); }
    var el = ev.target.closest("[data-el]");
    if (!el || el.closest(".drawer") || el.closest(".review-chrome")) return;
    // no preventDefault: the mock's own controls (details, checkboxes) must still work
    select(el.dataset.el);
  });

  document.getElementById("d-status").addEventListener("change", function (ev) {
    if (!current) return;
    review[current] = review[current] || {};
    review[current].status = ev.target.value;
    prune(current); save(); paint();
    document.getElementById("d-row").textContent = rowMarkdown(current);
  });
  document.getElementById("d-note").addEventListener("input", function (ev) {
    if (!current) return;
    review[current] = review[current] || {};
    review[current].note = ev.target.value;
    prune(current); save(); paint();
    document.getElementById("d-row").textContent = rowMarkdown(current);
  });
  function prune(id) {
    var rv = review[id];
    if (rv && !rv.note && (!rv.status || rv.status === (BY_ID[id] && BY_ID[id].status))) delete review[id];
  }

  document.getElementById("d-next").addEventListener("click", function () { step(1); });
  document.getElementById("d-prev").addEventListener("click", function () { step(-1); });
  function step(dir) {
    var idx = current ? ROWS.findIndex(function (r) { return r.id === current; }) : -1;
    for (var i = 1; i <= ROWS.length; i++) {
      var r = ROWS[(idx + dir * i + ROWS.length * 40) % ROWS.length];
      if (dir > 0 && statusOf(r.id) === "PROPOSED") { reveal(r); select(r.id); return; }
      if (dir < 0) { reveal(r); select(r.id); return; }
    }
    document.getElementById("d-progress").textContent = "sob row te-i kono na kono noddho ache — “Copy my edits” chanun";
  }
  function reveal(r) {
    var el = (placed[r.id] || []).filter(function (e) { return !e.dataset.auto; })[0] || (placed[r.id] || [])[0];
    if (!el) return;
    var screen = el.closest(".screen");
    if (screen) activate(screen.dataset.tab);
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" });
  }

  function copy(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ok = false, ta;
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
    document.getElementById("d-form").hidden = false;
    document.getElementById("d-empty").hidden = true;
    box.textContent = text;
    if (label) document.getElementById("d-progress").textContent = label;
    if (box.scrollIntoView) box.scrollIntoView({ block: "nearest" });
  }
  document.getElementById("export").addEventListener("click", function () {
    var text = exportReview();
    copy(text, function (ok) {
      if (ok) document.getElementById("d-progress").textContent = "copy hoyeche — WEB.md-e paste korun";
      else showInDrawer(text, "clipboard block — niche theke select kore nin");
    });
  });
  document.getElementById("download").addEventListener("click", function () {
    try {
      var blob = new Blob([exportReview() + "\n"], { type: "text/markdown" });
      var a2 = document.createElement("a");
      a2.href = URL.createObjectURL(blob);
      a2.download = "crabby-web-review.md";
      document.body.appendChild(a2); a2.click();
      setTimeout(function () { URL.revokeObjectURL(a2.href); a2.remove(); }, 500);
    } catch (e) { showInDrawer(exportReview(), "download block — niche select korun"); }
  });
  document.getElementById("reset").addEventListener("click", function () {
    if (!confirm("Apnar local status/note bad debo? WEB.md kichu change hoy nai.")) return;
    review = {}; save(); paint();
    if (current) select(current);
  });

  function exportReview() {
    var changed = ROWS.filter(function (r) { var rv = review[r.id]; return rv && (rv.status || rv.note); });
    if (!changed.length) return "Ekhono kichu bodlao ni. Element e click korun → status/note → ei button paste-ready row debe.";
    var lines = ["", "Owner review pass — " + changed.length + " of " + ROWS.length +
      " rows changed. Each block below replaces the row of the same ID in `docs/review/WEB.md`.", ""];
    var byRegion = {};
    changed.forEach(function (r) { (byRegion[r.region] = byRegion[r.region] || []).push(r); });
    Object.keys(byRegion).forEach(function (region) {
      lines.push("### " + region + " — " + (byRegion[region][0].region_title || ""), "");
      byRegion[region].forEach(function (r) { lines.push(rowMarkdown(r.id)); });
      lines.push("");
    });
    var qs = changed.filter(function (r) { return statusOf(r.id) === "?"; });
    if (qs.length) {
      lines.push("### Blocking questions");
      qs.forEach(function (r) { lines.push("- " + r.id + " (" + r.element + "): " + ((review[r.id] || {}).note || "note nei")); });
    }
    return lines.join("\n");
  }

  /* ---------- chrome controls ---------- */
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
  seg("viewport", "v", function (v) { stage.dataset.viewport = v; layoutBars(); });
  seg("theme", "t", function (t) { document.documentElement.dataset.theme = t; });
  seg("density", "d", function (d) { document.documentElement.dataset.density = d; });
  document.getElementById("labels").addEventListener("change", function (ev) {
    stage.dataset.labels = ev.target.checked ? "on" : "off";
  });
  ["sim-vault", "sim-offline", "sim-tunnel", "sim-firstrun"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", function () { runStates(); layoutBars(); });
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

  /* ---------- W1-A live: the bar at 360px, on every screen ---------- */
  var BAR_ITEMS = ["W1-01", "W1-02", "W1-03", "W1-04", "W1-05", "W1-06", "W1-07", "W1-08", "W1-09"];
  var ESCAPERS = { "W1-07": "sim-vault", "W1-04": "sim-offline" };
  function layoutBars() {
    var narrow = stage.dataset.viewport === "phone";
    var keep = ["W1-01", "W1-02", "W1-03", "W1-05", "W1-06"];
    Object.keys(ESCAPERS).forEach(function (id) {
      if (document.getElementById(ESCAPERS[id]).checked) keep.push(id);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".screen"), function (screen) {
      var collapsed = [];
      BAR_ITEMS.forEach(function (id) {
        var hid = narrow && keep.indexOf(id) < 0;
        // only the chips inside the bar collapse; the tunnel banner shares W1-06 and is a
        // page-level element, so it must not be hidden by bar arithmetic
        instances(id, screen.dataset.tab).filter(function (el) { return el.closest(".bar"); })
          .forEach(function (el) { el.hidden = hid; });
        if (hid) collapsed.push(id);
      });
      var btn = screen.querySelector("[data-more]");
      if (btn) btn.hidden = !narrow;
      var sheet = screen.querySelector(".more-sheet");
      if (sheet) {
        sheet.innerHTML = collapsed.length ? collapsed.map(function (id) {
          var r = BY_ID[id];
          return '<div class="row" data-el="' + id + '"><strong>' + esc(r ? r.element : id) + "</strong>" +
            '<span class="note">' + esc(r ? r.text : "") + "</span></div>";
        }).join("") : '<div class="row"><span class="note">ei width e kichu collapse hoy nai</span></div>';
        if (narrow) {
          var escaped = ["W1-04", "W1-07"].filter(function (id) { return keep.indexOf(id) >= 0; });
          if (escaped.length) {
            var warn = document.createElement("div");
            warn.className = "row";
            warn.innerHTML = '<span class="note note--warn">sheet theke bar e oranto: ' + escaped.join(", ") +
              " — ei duitor ortho screen er upor bhorsha bodle</span>";
            sheet.appendChild(warn);
          }
        }
        decorateAll(sheet);
        sheet.hidden = true;
      }
    });
    instances("W-O1").forEach(function (el) {
      el.hidden = !document.getElementById("sim-firstrun").checked;
    });
  }
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-more]");
    if (!btn) return;
    ev.stopPropagation();
    var sheet = btn.closest(".screen").querySelector(".more-sheet");
    if (sheet) sheet.hidden = !sheet.hidden;
  });
  // one sheet per screen, right under the bar
  Array.prototype.forEach.call(document.querySelectorAll("[data-more]"), function (btn) {
    var sheet = document.createElement("div");
    sheet.className = "list more-sheet";
    sheet.dataset.el = "W1-11";
    sheet.hidden = true;
    btn.parentNode.parentNode.insertBefore(sheet, btn.parentNode.nextSibling);
  });

  function runStates() {
    var vault = document.getElementById("sim-vault").checked;
    var offline = document.getElementById("sim-offline").checked;
    var tunnel = document.getElementById("sim-tunnel").checked;
    Array.prototype.forEach.call(document.querySelectorAll('.bar .chip[data-el="W1-06"],.bar .chip[data-el="W1-07"],.bar .chip[data-el="W1-04"]'), function (el) {
      var id = el.dataset.el;
      if (id === "W1-06") {
        el.dataset.tone = tunnel ? "tunnel" : "off";
        el.innerHTML = '<span class="chip__dot"></span>tunnel: ' + (tunnel ? "k7x-abcd" : "off") + '<span class="el-label">W1-06</span>';
      } else if (id === "W1-07") {
        el.dataset.tone = vault ? "err" : "ok";
        el.innerHTML = '<span class="chip__dot"></span>vault: ' + (vault ? "locked" : "unlocked") + '<span class="el-label">W1-07</span>';
      } else {
        el.dataset.tone = offline ? "err" : "info";
        el.innerHTML = '<span class="chip__dot"></span>' + (offline ? "offline · last seen 21:44" : "reconnecting") +
          '<span class="el-label">W1-04</span>';
      }
    });
    instances("W6-13").forEach(function (el) {
      if (el.classList.contains("chip") || el.tagName === "BUTTON") el.textContent = offline ? "live tail: paused (2 deferred)" : "live tail: on";
      else el.textContent = offline ? "paused — 2 events deferred" : "live tail";
    });
    Array.prototype.forEach.call(document.querySelectorAll(".banner[data-el='W1-06']"), function (b) {
      b.hidden = !tunnel;
      b.innerHTML = "This page is reachable through the tunnel (<code>k7x-abcd</code>). Ja approve korben sheita ei phone-e cholbe. " +
        '<button class="btn btn--ghost" data-el="W13-06" data-goto="access">turn off</button><span class="el-label">W1-06</span>';
      decorate(b);
    });
  }

  /* keyboard: j/k walk the open screen, a/d/x/? decide */
  document.addEventListener("keydown", function (ev) {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (ev.key === "Escape") {
      Array.prototype.forEach.call(document.querySelectorAll('.el[data-selected="true"]'), function (el) { el.dataset.selected = "false"; });
      Array.prototype.forEach.call(document.querySelectorAll(".more-sheet"), function (s) { s.hidden = true; });
      return;
    }
    var list = Array.prototype.filter.call(
      document.querySelectorAll('.screen[data-active="true"] [data-el]'),
      function (el) { return !el.hidden && !el.closest(".more-sheet") && el.offsetParent; });
    var idx = current ? list.findIndex(function (el) { return el.dataset.el === current; }) : -1;
    if (ev.key === "j" || ev.key === "k") {
      ev.preventDefault();
      var nxt = list[Math.max(0, Math.min(list.length - 1, idx + (ev.key === "j" ? 1 : -1)))];
      if (nxt) { select(nxt.dataset.el); if (nxt.scrollIntoView) nxt.scrollIntoView({ block: "nearest" }); }
    } else if (current && "adx".indexOf(ev.key) >= 0) {
      review[current] = review[current] || {};
      review[current].status = { a: "ACCEPTED", d: "EDIT", x: "CUT" }[ev.key];
      prune(current); save(); paint();
      var next = list[idx + 1];
      if (next) { select(next.dataset.el); if (next.scrollIntoView) next.scrollIntoView({ block: "nearest" }); }
    } else if (current && ev.key === "?") {
      review[current] = review[current] || {};
      review[current].status = "?";
      save(); paint();
      document.getElementById("d-note").focus();
    }
  });

  paint(); layoutBars(); runStates();
  if (ROWS.length) select(ROWS[0].id);
})();
