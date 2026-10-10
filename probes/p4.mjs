// P4 — the Web UI's delivery mechanism, without a framework and without a build step.
// Pass condition (docs/ROADMAP.md §2): a framework-free bundle served by the Gateway, usable at 360px, with the four
// chips and a more sheet. The 360px *rendering* is a device/browser judgement, so this probe measures everything that
// is not: that the document is self-contained, that the Gateway serves it as-is, that nothing in the CSS forces a
// width past the design case, and that the four chips in the fixture are the four the spec's overflow rule names.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import {
  ensureDep,
  envFacts,
  Probe,
  parseArgs,
  REPO_DIR,
  report,
  spawnReady,
  stageChild,
} from "./lib.mjs";

const probe = new Probe(
  "P4",
  "framework-free Web document, served by Fastify, within the 360px design case",
);
const args = parseArgs();
const fixture = path.join(REPO_DIR, "probes", "children", "web-fixture");
const read = (name) => readFileSync(path.join(fixture, name), "utf8");
const html = read("index.html");
const css = read("app.css");
const js = read("app.js");

console.log(`P4 · ${envFacts().node} on ${envFacts().platform}`);

// 1. the fixture must not drift from the rule it claims to implement
const design = (() => {
  try {
    return readFileSync(path.join(REPO_DIR, "docs", "DESIGN_SYSTEM.md"), "utf8");
  } catch {
    return "";
  }
})();
const spec = (() => {
  try {
    return readFileSync(path.join(REPO_DIR, "docs", "UI_UX_SPEC.md"), "utf8");
  } catch {
    return "";
  }
})();
const line = spec.split("\n").find((l) => /overflow rule/i.test(l) && /four chips/i.test(l)) ?? "";
const named = (/(?:fits four chips|four chips)\s*[—-]\s*([^\n.(]+)/.exec(line)?.[1] ?? "")
  .split(",")
  .map((s) =>
    s
      .trim()
      .replace(/\s*[—-]\s*$/, "")
      .toLowerCase(),
  )
  .filter(Boolean);
const drawn = ["model", "connection", "approvals", "vault"].filter((id) =>
  html.includes(`id="chip-${id}"`),
);
probe.check(
  "the fixture's chips are the four named by the spec's overflow rule",
  named.length === 4 && drawn.length === 4 && named.every((n, i) => n.startsWith(drawn[i])),
  named.length
    ? `spec says ${named.join(", ")}`
    : "could not read the rule out of UI_UX_SPEC.md — the check needs fixing, not the doc",
);

// 2. self-contained: no bundler, no package specifiers, no build step
const bareImports = /^\s*(?:import|export)[^;]*?from\s+["'][^./"']["']/m.test(js);
const refsModules = /node_modules|require\(/.test(js + html);
probe.check(
  "the script imports nothing but the document itself",
  !bareImports && !refsModules,
  bareImports ? "a bare module specifier needs a bundler" : "relative paths only",
);
const externalRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => /^https?:\/\//.test(u));
probe.check(
  "no external resource, so it works with the network off",
  externalRefs.length === 0,
  externalRefs.join(", ") || "none",
);

// 3. the 360px rule, measured statically because a container cannot judge a phone screen
const tooWide = [...css.matchAll(/min-width:\s*(\d+)px/g)]
  .filter((m) => Number(m[1]) > 360)
  .map((m) => m[0]);
probe.check(
  "no min-width pushes the layout past the 360px design case",
  tooWide.length === 0,
  tooWide.join(", ") || "largest forced width: none",
);
const fixedDesktop = [...css.matchAll(/@media[^{]*min-width:\s*(\d{4,})px/g)].map((m) => m[1]);
probe.note(
  "desktopBreakpoints",
  fixedDesktop.length
    ? fixedDesktop.join(",")
    : "none in the fixture — the 1024px case arrives with M-W's real sheet",
);

// 4. serve it, the way the Gateway will
const dep = await ensureDep("fastify", "5.12.5");
if (!dep.ok) {
  probe.block(
    "the Gateway can serve the document",
    `${dep.reason} — run P2 first, it installs what this needs`,
  );
} else {
  const child = spawnReady(stageChild("web-gateway.mjs"), {
    readyMarker: "READY",
    args: [fixture],
  });
  let port = 0;
  try {
    port = Number((await child.ready).split(" ")[1]);
  } catch (err) {
    probe.check("the Gateway bound and answered", false, String(err.message).slice(0, 160));
  }
  // the palette rule P4's pass condition names: the served values *are* DESIGN_SYSTEM §2.3, read from the document
  const table = (/(?:^|\n)### 2\.3[^\n]*\n[\s\S]*?\n\| Token[^\n]*\n(?:\|[^\n]+\n)+/.exec(
    design,
  ) ?? [""])[0];
  const palette = new Map();
  for (const row of table.split("\n")) {
    const cells = row.split("|").map((c) => c.trim());
    if (cells.length > 4 && /^`[a-z.]+`$/.test(cells[1] ?? "")) {
      const hexes = [cells[2], cells[3]]
        .map((c) => /#[0-9a-f]{6}/i.exec(c ?? "")?.[0]?.toLowerCase())
        .filter(Boolean);
      if (hexes.length) palette.set(cells[1].replace(/`/g, ""), hexes);
    }
  }
  const used = [...css.matchAll(/--[a-z-]+:\s*(#[0-9a-f]{6})/gi)].map((m) => ({
    name: m[0].split(":")[0].trim().replace(/^--/, ""),
    hex: m[1].toLowerCase(),
  }));
  probe.check(
    "every colour the fixture ships is a §2.3 value of the token it is named after",
    palette.size > 6 &&
      used.length > 6 &&
      used.every((u) => {
        const token = u.name.replace(/-/g, ".");
        const allowed = palette.get(token) ?? palette.get(u.name.replace(/-/g, "."));
        return Boolean(allowed?.includes(u.hex));
      }),
    `${palette.size} tokens read out of DESIGN_SYSTEM.md §2.3, ${used.length} custom properties checked`,
  );

  if (port) {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    const body = await res.text();
    probe.check(
      "GET / returns the document as text/html with no-cache",
      res.headers.get("content-type")?.includes("text/html") &&
        res.headers.get("cache-control") === "no-cache",
      `ttfb ${Date.now() - t0}ms, ${body.length}B, cache-control=${res.headers.get("cache-control")}`,
    );
    probe.check(
      "the served bytes are the file's bytes, unchanged",
      body === html,
      body.length === html.length ? "byte-identical" : "transformed in transit",
    );
    for (const asset of ["app.css", "app.js"]) {
      const r = await fetch(`http://127.0.0.1:${port}/${asset}`, {
        signal: AbortSignal.timeout(3000),
      });
      probe.check(
        `${asset} is served with a type a browser accepts`,
        (await r.text()).length > 0 &&
          /text\/(css|javascript)/.test(r.headers.get("content-type") ?? ""),
        r.headers.get("content-type") ?? "no content-type",
      );
    }
    const api = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    probe.check(
      "one listener serves the UI and the API from one origin",
      api.ok && port > 0,
      `/health and / answered on ${port} with no dev server and no second port in front of them`,
    );
    const total = html.length + css.length + js.length;
    probe.note(
      "servedBytes",
      `${total}B raw, ${gzipSync(html + css + js).length}B gzipped for all three files`,
    );
    probe.note(
      "budgetNote",
      "no byte budget is recorded in the plan, so this is a measurement, not a verdict",
    );
  }
  child.child.kill("SIGKILL");
  await sleep(80);
}

const script = spawnSync("script", ["-q", "/dev/null", "true"], { stdio: "ignore" });
probe.note(
  "ptyAvailable",
  script.status === 0
    ? "`script` present, so P5 can allocate a real terminal"
    : "no `script` here; P5 will block on a machine that cannot fake a tty",
);

probe.manual(
  "open the fixture at 360px on the phone and try the more sheet",
  `npm run probe:p4 prints nothing about rendering — that is deliberate. Point a browser at http://127.0.0.1:<port>/ in a
      360px-wide window (or the phone), confirm four chips fit without horizontal scroll, then tap more. The owner's
      verdict on this step is the row in probes/RESULTS.md, and per D-076 it changes code and inventory in one commit.`,
);
probe.manual(
  "confirm the transcript updates without a reload",
  `the SSE channel is P2's, the DOM patching rule is M-W's; here the question is only whether a plain document plus a
      script is enough to hang a stream off — type in the composer and watch the transcript node grow`,
);

report(probe, args);
