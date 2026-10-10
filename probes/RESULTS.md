# M0 results

The record for the eight pre-implementation probes in `docs/ROADMAP.md` §2. Two columns matter and only one of them can
be filled in on a laptop:

| environment | what a result here means |
| --- | --- |
| the container | the probe works, and the assumption holds for the runtime it was run on. Nothing more. |
| Termux on the phone | the assumption holds for the runtime the product will actually use. **This is the column M0 is waiting for.** |

Rules that keep this honest, both enforced by `probes/lib.mjs` rather than by willpower:

- a probe that cannot check its precondition exits **2 (blocked)**, never 0 — a missing toolchain, a missing device, or
  a network that will not fetch Node headers is *absence of evidence*, and `probes/out/*.json` is what the numbers come from;
- every `… you:` step in a probe's output is a device step, and it is part of the record: a probe whose automated half
  passes has not passed M0 until the manual half has an answer here.

## Measured

The block below is generated. Do not edit it by hand — run `npm run probe` (or a single `npm run probe:p3`) and then
`node probes/to-results.mjs`, which rewrites it from `probes/out/*.json`. `npm run probe:results -- --check` fails when
the file and the JSON disagree, and that is the guard against the failure mode recorded as F-24 in
`docs/CONSISTENCY_REVIEW.md`: a summary that stopped matching the thing it summarises.

<!-- measured:begin -->

| probe | status | pass/fail/blocked | manual steps | environment |
| --- | --- | --- | --- | --- |
| P1 | pass | 4/0/0 | 2 | v22.22.3 · linux/x64 · not Termux |
| P2 | pass | 8/0/0 | 2 | v22.22.3 · linux/x64 · not Termux |
| P3 | blocked | 12/0/1 | 2 | v22.22.3 · linux/x64 · not Termux |
| P4 | pass | 10/0/0 | 2 | v22.22.3 · linux/x64 · not Termux |
| P5 | fail | 14/1/0 | 3 | v22.22.3 · linux/x64 · not Termux |
| P6 | blocked | 4/0/1 | 3 | v22.22.3 · linux/x64 · not Termux |
| P7 | pass | 13/0/0 | 2 | v22.22.3 · linux/x64 · not Termux |

### P1 · Node runtime baseline: .ts and node --test with no flags, no loader, no esbuild

Status `pass` — 4 passed, 0 failed, 0 blocked, 2 manual step(s), 502ms, `probes/out/P1.json`, recorded 2026-10-10T05:22:44.546Z.

- node: v22.22.3
- npm: 10.9.8
- v8: 12.4.254.21-node.56
- enginesNote: package.json has no `engines` until this probe has been run on Termux (D-070)

<summary>every check this run</summary>

- ✓ node file.ts runs erasable TypeScript unflagged — ERASABLE_OK ok
- ✓ node --test runs a .ts test file — 1 pass
- ✓ --experimental-test-coverage prints a table
- ✓ enum is refused by the runtime (D-070's constraint is enforced, not stylistic) — SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode

### P2 · Fastify Gateway on loopback: /health, hijacked SSE, restart after SIGKILL

Status `pass` — 8 passed, 0 failed, 0 blocked, 2 manual step(s), 1037ms, `probes/out/P2.json`, recorded 2026-10-10T05:22:45.620Z.


<summary>every check this run</summary>

- ✓ fastify installs and imports — 64ms to install
- ✓ server bound to 127.0.0.1 and reported a port — 127.0.0.1:36929
- ✓ GET /health answers JSON — {"ok":true,"pid":11273,"node":"v22.22.3"}
- ✓ SSE through reply.hijack() delivers ordered events — 5 events, first in 40ms, total 204ms
- ✓ event ids are monotonic (the per-task seq contract starts from a working transport) — 1,2,3,4,5
- ✓ child is gone after SIGKILL — pid 11273
- ✓ the killed process holds nothing on the port — connection refused
- ✓ restart binds again with no cleanup step — READY 33523

### P3 · better-sqlite3: how it loads, whether it compiles, WAL, and a crash during a write

Status `blocked` — 12 passed, 0 failed, 1 blocked, 2 manual step(s), 4452ms, `probes/out/P3.json`, recorded 2026-10-10T05:22:50.120Z.

- loadedBinding: /home/user/Crabby/probes/.deps/node_modules/better-sqlite3/prebuilds/linux-x64.node
- termuxLoaderChoice: would reach for linuxmusl-arm64.node or linuxmusl-x64.node
- reportedClaim: DECISIONS.md §5.3 reported transactions, WAL and crash recovery on Termux; this project had not reproduced it

<summary>every check this run</summary>

- ✓ the package installs — 12ms
- ✓ a native binding loads and answers a query — linux-x64.node (bundled prebuild)
- ✓ the installed loader still prefers `prebuilds/` over a local build — so a Termux source build needs prebuilds out of the way
- ✓ the musl guess is "no glibc", which is also Termux's shape — isLinuxMusl() reads process.report.getReport().header.glibcVersionRuntime
- ✓ the loader would pick a musl-named prebuild on Termux, and that file ships — prebuilds/linuxmusl-arm64.node, linuxmusl-x64.node — musl on a bionic runtime is the failure the device run confirms or refutes
- ▢ node-gyp fetches the Node headers it compiles against — gyp ERR! stack Error: Client network socket disconnected before secure TLS connection was established — this sandbox reaches only a few hosts (docs/DEVELOPMENT.md §12), so the build is untested here, not failed. On a phone this line becomes a real number: header download plus compile time.
- ✓ better-sqlite3: integrity_check ok after a crash mid-write — integrity=ok
- ✓ better-sqlite3: committed rows are whole batches, so no torn write survived — 1100 rows recovered after 11 reported batches (batch=100)
- ✓ better-sqlite3: a checkpoint runs on the recovered file — db=100KB, -wal after checkpoint=0B
- ✓ `node:sqlite` exists for the same-case comparison — exit 0
- ✓ node:sqlite: integrity_check ok after a crash mid-write — integrity=ok
- ✓ node:sqlite: committed rows are whole batches, so no torn write survived — 1400 rows recovered after 13 reported batches (batch=100)
- ✓ node:sqlite: a checkpoint runs on the recovered file — db=128KB, -wal after checkpoint=0B

### P4 · framework-free Web document, served by Fastify, within the 360px design case

Status `pass` — 10 passed, 0 failed, 0 blocked, 2 manual step(s), 348ms, `probes/out/P4.json`, recorded 2026-10-10T05:22:50.507Z.

- desktopBreakpoints: none in the fixture — the 1024px case arrives with M-W's real sheet
- servedBytes: 4867B raw, 2038B gzipped for all three files
- budgetNote: no byte budget is recorded in the plan, so this is a measurement, not a verdict
- ptyAvailable: no `script` here; P5 will block on a machine that cannot fake a tty

<summary>every check this run</summary>

- ✓ the fixture's chips are the four named by the spec's overflow rule — spec says model, connection, approvals, vault
- ✓ the script imports nothing but the document itself — relative paths only
- ✓ no external resource, so it works with the network off — none
- ✓ no min-width pushes the layout past the 360px design case — largest forced width: none
- ✓ every colour the fixture ships is a §2.3 value of the token it is named after — 15 tokens read out of DESIGN_SYSTEM.md §2.3, 22 custom properties checked
- ✓ GET / returns the document as text/html with no-cache — ttfb 34ms, 1745B, cache-control=no-cache
- ✓ the served bytes are the file's bytes, unchanged — byte-identical
- ✓ app.css is served with a type a browser accepts — text/css; charset=utf-8
- ✓ app.js is served with a type a browser accepts — text/javascript; charset=utf-8
- ✓ one listener serves the UI and the API from one origin — /health and / answered on 36695 with no dev server and no second port in front of them

### P5 · Ink 8 in a 40x24 pty: width, key decoding, colour depth

Status `fail` — 14 passed, 1 failed, 0 blocked, 3 manual step(s), 39300ms, `probes/out/P5.json`, recorded 2026-10-10T05:23:29.854Z.

- ✗ repaint stays at or under the 4 fps P5's pass condition names (Ink caps nothing, so the app must) — ≈289.7 repaints/s here against the 4/s the condition names — a measurement, not a broken probe; M-T owns the throttle and P-011 is queued
- burstVsPaced: burst: 2 events / 200 chars; paced: 198 events / 200 chars; Ink painted 199 times during the paced run (289.7/s)
- keyLog: a b a(ctrl) (leftArrow) <LF> <CR>(return+shift) <CR>(return)

<summary>every check this run</summary>

- ✓ Ink's layout is WebAssembly, so it needs no device compiler — yoga-layout 3.2 ships yoga-wasm-base64-esm.js — unlike better-sqlite3 (P3) this is not a build risk
- ✓ nothing was written past the 40th cell, so the terminal never had to wrap — widest row 39 cells, cells past the edge 0, 7 painted rows
- ✓ the Bengali line survives the render instead of turning into blanks or question marks — "এ" present; how the marks *shape* is a phone question, not a byte question
- ✓ Ctrl+J arrives as LF, and Enter as CR, so the composer can tell them apart — LF 1 (flags ""), CR 2, newlines inserted 1, submits 1
- ✓ the kitty Shift+Enter sequence arrives as a distinct chord, legacy CR does not — return+shift seen 1×, plain return 1× — a terminal that sends neither is what O-051 must decide on the phone
- ✓ readline-style controls reach useInput named (Ctrl+A, arrows), so the TUI can move a caret — a:- b:- a:ctrl :leftArrow <LF>:- <CR>:return+shift <CR>:return
- ✓ Ctrl+C ends the app in both modes, with exit code 0 and no leftover signal — exitOnCtrlC default 0, opted out 0
- ✓ the default swallows the key, so the TUI must set exitOnCtrlC:false to act on it — handler saw it: default false, opted out true — M-T writes this into the app's input layer, not into a document
- ✓ Shift+Enter added a line without submitting, which is the rule the composer needs — shift+CR 1, submits 1, newlines 1
- ✓ no painted row starts with a dangling combining mark, so nothing split a cluster at the wrap — 24 painted rows checked with Intl.Segmenter; the phone's own shaping is a manual step
- ✓ all 200 characters survive a burst, even though stdin coalesces them into fewer events — 2 handler calls carried 200 characters in 1ms — counting events instead of characters invents lost keystrokes
- ✓ paced keystrokes are all accounted for while the frame repaints between them — 198 events for 200 characters over 687ms, 199 frames painted
- ✗ repaint stays at or under the 4 fps P5's pass condition names (Ink caps nothing, so the app must) — ≈289.7 repaints/s here against the 4/s the condition names — a measurement, not a broken probe; M-T owns the throttle and P-011 is queued
- ✓ the node:readline fallback distinguishes the same three keys Ink does — fallback saw newlines 2, submits 1, shift+enter 1, caret moves 2 — the control keeps the same composer rule without a dependency
- ✓ with TERM=xterm and no COLORTERM the stream carries no truecolour — truecolour absent, 256-colour escapes absent — whether that is *readable* at 8 colours is DESIGN_SYSTEM's claim, this only shows Ink obeys the environment

### P6 · process lifetime: survives the parent shell, stops cleanly on a signal

Status `blocked` — 4 passed, 0 failed, 1 blocked, 3 manual step(s), 1188ms, `probes/out/P6.json`, recorded 2026-10-10T05:23:31.106Z.


<summary>every check this run</summary>

- ✓ a detached process keeps serving after its parent exits — pid 11468 answering on 45725; the launcher that started it exited first
- ✓ it kept working without a controlling terminal — 2 beats written while detached
- ✓ SIGTERM is handled: it stops accepting work, flushes, and exits 0 — flushed after 47ms of life, exit code 0
- ✓ the port is released once the signal has been handled — answered for 7ms after the kill, then closed
- ▢ what the phone does to this process is unknown until a device answers — Doze, battery optimisation, a task-swipe kill and termux-wake-lock cannot be simulated in a container. This run is recorded as blocked, not passed — the harness's rule for a missing precondition (probes/README.md)

### P7 · hostile extension against the node:vm sandbox the plan leans on

Status `pass` — 13 passed, 0 failed, 0 blocked, 2 manual step(s), 346ms, `probes/out/P7.json`, recorded 2026-10-10T05:23:31.492Z.

- ceiling: same-uid, same-kernel: a sandboxed extension still shares the filesystem with the host process. SECURITY.md §15 already says a Termux process can read anything in the profile, so this is deterrence and audit, not isolation.
- hostApisExposed: crabby.fs.read/write, crabby.net.fetch, crabby.shell.run, note() — nothing else was passed in

<summary>every check this run</summary>

- ✓ the sandbox has no require, module, process, fetch, Worker or Buffer in scope — undefined,undefined,undefined,undefined,undefined,undefined
- ✓ nothing host-shaped is even a name on the sandbox's global object — none
- ✓ eval, new Function, and Function via the prototype chain are all refused (codeGeneration.strings:false) — eval: refused; Function: refused; constructor: refused; proto chain: refused
- ✓ WebAssembly exists as a name but compiling is refused too (codeGeneration.wasm:false) — WebAssembly.Module(): Wasm code generation disallowed by embedder
- ✓ no attempt handed back the host process object — reachable-by-shape check on every return value
- ✓ dynamic import() from inside the sandbox cannot load a host module — BLOCKED:ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING
- ✓ a runaway extension is stopped by the run timeout, and the host survives it — 251ms to interrupt `while(true){}`; error ERR_SCRIPT_EXECUTION_TIMEOUT
- ✓ the timeout number is honoured within a tolerance (the limits table is enforceable) — asked for 250ms, took 251ms
- ✓ the host's own path rule holds the line the sandbox cannot (D-034) — refused: fs.read: "/etc/passwd" is outside the workspace (D- | contents of notes/todo.md
- ✓ shell.run is unreachable without an approval the extension cannot grant itself — refused: shell.run needs an approval the host grants, not the extension
- ✓ every call the extension made is visible to the host afterwards (the audit trail is real) — 4 audited calls: fs.read /etc/passwd / fs.read ../../home/.ssh/id_ed25519 / fs.read notes/todo.md
- ✓ a frozen host API cannot be swapped out from inside the sandbox — assign to frozen group: refused: Cannot assign to read only property 'read' of objec
- ✓ overwriting `crabby` in the sandbox changes only the sandbox's copy — the host object it replaced was never the host's


<!-- measured:end -->

## What the container run already changed

These are findings from `probes/`, not device results. Two of them became register rows, so they are not parked here as
anecdotes; each line says where it landed.

1. **`better-sqlite3` 13 does not compile on install, and its loader prefers a bundled prebuild over a local build.**
   It ships `prebuilds/{linux,darwin,win32}{,musl}-{x64,arm64}.node` and picks among them using "no glibc in the process
   report" as the musl test — which is also Termux's shape, since Termux is bionic. On the phone, then, "builds from
   source" is neither automatic nor a matter of `npm install`: `prebuilds/` has to be out of the way, or the compiled
   binding loaded by path (which P3 proves works, via `nativeBinding`). Recorded in `P-004`; the compile time and the
   load result on bionic are still the device's to give (O-001, O-002). What the container *did* settle: killing a writer
   mid-transaction left both drivers reporting `integrity_check ok`, with recovered rows that are whole multiples of the
   100-row batch. The counts differ per run — how far a writer gets before the kill is timing — so they live in the
   generated lines below rather than being quoted here. §5's report reproduced, on a non-Android runtime: the WAL claim
   holds; the phone still decides O-001.
2. **`node:vm` refuses every string-to-code door, and its timeout is precise.** With `codeGeneration: { strings: false,
   wasm: false }`: `eval`, `new Function`, `Function` reached through a prototype chain, `WebAssembly.Module`, and
   `import()` of a host module all throw; `while(true){}` was interrupted at the 250 ms it asked for; a frozen host
   API cannot be reassigned from inside, and overwriting `crabby` in the sandbox replaces only the sandbox's copy. Thirteen
   checks, all passing (P7). The ceiling is unchanged and stated in the probe: same uid, same filesystem — this is
   deterrence with an audit trail, which is the choice O-008 has to make, not a sandbox escape proof.
3. **Ink 8's layout is WebAssembly** (`yoga-layout` ships a base64 wasm blob), so unlike the storage driver it needs no
   compiler on the device. P3's number is now the only native-toolchain risk M0 carries.
4. **The composer's key rules are measurable, and two of them were not written down anywhere.** Ctrl+J reaches
   `useInput` as LF and Enter as CR, so they are distinguishable; a terminal that speaks kitty delivers Shift+Enter as
   `return+shift`, and the composer must test the shift flag *before* treating CR as a submit or a kitty terminal submits
   when the user meant to add a line. Ink's default `exitOnCtrlC: true` means the app never sees Ctrl+C — an app that has
   to flush on that key sets it to `false` and handles the key itself. Both are in `P-010`'s row for M-T to implement;
   whether the phone's terminal speaks kitty at all stays with O-051.
5. **Ink does not cap its repaint rate, so the plan's 4 fps rule is an obligation on our code.** 200 keystrokes 3 ms
   apart, in the run recorded below: all 200 characters reached the handler, and the frame was repainted around 300
   times a second. P5 reports that as a
   *failed* check on purpose — the condition was written to be falsifiable and it was falsified in a container, before
   M-T was designed around the opposite assumption. `P-011` is the proposal that owns a render throttle; the row's
   wording was not softened (F-26).
6. **stdin coalesces, so an input path that counts events will believe it lost keystrokes.** The same 200 characters
   written in one `stdin.write` arrived as 2 handler calls. `P5` asserts on characters, not calls; M-T's composer has to
   do the same.
7. **`docs/ROADMAP.md` P4 pointed at "§2.3" and two documents have one.** The probe read `UI_UX_SPEC.md`'s §2.3 (Empty
   states) instead of `DESIGN_SYSTEM.md`'s palette and would have checked nothing; the row names the file now, and P4
   reads the palette table out of the document so a re-measured palette moves the fixture instead of drifting from it
   (F-25).

## Device checklist, per probe

| probe | on the phone | the answer this needs |
| --- | --- | --- |
| P1 | `npm run probe:p1` after `pkg install nodejs-lts` | the Node `package` ships, and whether type stripping and `node --test` work there. That version becomes `engines.node` — see `docs/DEVELOPMENT.md` §1, which is why the manifest has no `engines` yet (D-070) |
| P2 | `npm run probe:p2` | install time on 4G, and whether the hijacked SSE stream survives a phone's idea of a network |
| P3 | `pkg install python make clang`, then `npm run probe:p3` | whether it compiles at all on bionic, how long it takes, and whether `integrity_check` is `ok` after a kill during a write |
| P4 | `npm run probe:p4`, open the printed URL at 360px | four chips without horizontal scroll, and a more sheet that opens with one thumb |
| P5 | `npm run probe:p5` in the terminal you use | 40-column readability, Shift+Enter (O-051), screen-reader mode (O-006) |
| P6 | `npm run probe:p6`, then background, Doze, and a task-swipe | how long the beats keep coming, and whether Termux's notification is what bought it |
| P7 | `npm run probe:p7` | the same seven doors on Termux's Node; a pass here and a fail there is the answer, not a surprise |

## Closing M0

Not this file. `docs/ROADMAP.md` §2: M0 exits when each probe's written result is recorded in `DECISIONS.md` and every
`Proposed` choice a probe touched is resolved. When a device answer contradicts the plan, the contradiction is the
finding — record it, change the affected rows in `docs/review/*` through `python3 scripts/count-inventory.py`, and let
`docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` be regenerated (P8) rather than patched by hand.
