# Crabby — Development Guide

> **Document status:** Planning draft. Written before code exists, so the workflow is a specification rather than a
> description of habits.
>
> **Related:** `docs/ROADMAP.md`, `AGENTS.md`, `ARCHITECTURE.md` §18/§19, `DECISIONS.md`

## 1. Environment

| Requirement | Version / note |
| --- | --- |
| Node.js | LTS; supported range pinned by M0 P1 and recorded in `DECISIONS.md` (O-002 context: reports tested v22.x–v26.x on Termux) |
| Package manager | npm with workspaces (P-005), decided by D-060 (closing O-003): the install story is clone + `npm install`, and asking a Termux user to install a second package manager to build a local tool buys nothing |
| Install model | D-050: clone/checkout + `npm install`, `--build-from-source` where native modules need it; no global install, no self-updater in v1 | — with one measured caveat (F-38): if the Node headers host is unreachable, `better-sqlite3`'s build step is where a clean install fails, and `npm install --ignore-scripts` works only while the npm cache already holds a matching prebuilt binary; `crabby doctor`'s native-toolchain check is where that surfaces
| TypeScript | `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; ESM only |
| Schema and validation | TypeBox 0.34 (D-060, closing O-005) — chosen over Zod because the API contract, `crabby config schema --json` and the generated `--help` all need JSON Schema as an output, not a conversion |
| Lint and format | `@biomejs/biome` 2.5 (D-060, closing O-047/O-048), zero runtime dependencies. The bare `biome` name on npm is an unrelated 2016 package; a `package.json` that asks for it installs the wrong thing without complaint |
| Runtime | `node` directly, in both modes: type stripping runs `.ts` without flags or a loader (D-070), and `tsx` is not a dependency because it pulls `esbuild`'s platform binary into the dev loop for no capability the project needs (D-069). Compiled output for release; no postinstall scripts in Crabby packages |
| Test runner | `node:test` with `node --test`, discovery of `*.test.ts`, coverage through `--experimental-test-coverage` (D-069). No Vitest, no Jest, no runner config file — the conventions are the runtime's |
| Native toolchain (Termux) | `pkg install python make clang` for `better-sqlite3` source builds — documented, and checked by `crabby doctor`. Not automatic: the package ships bundled prebuilds and its loader prefers them, and it picks between them by asking whether glibc is absent, which is also true on bionic (`probes/p3.mjs` measured the loader's rule; the phone still owes the compile time) |
| Types for the native driver | `@types/better-sqlite3` is a devDependency and the project's only `@types/*` package: `better-sqlite3` ships no bundled types, so `packages/storage` failed strict `tsc` with TS7016 until it was added (observed here, not inferred) — every other dependency D-060 names carries its own types |
| Editor | Any; `tsconfig` and lint config are the contract, not a specific IDE |

`engines.node` in the root `package.json` is authoritative. Anything that only works on the developer's machine is
a bug, and on this project "the developer's machine" may be a phone.

## 2. Repository Layout

Per `ARCHITECTURE.md` §18. Practical rule: create a package only when it holds code and has a real owner; the
proposed tree is a map, not a checklist. `packages/api-contracts` is the only package every interface may import
from, and interface apps never import core internals directly.

As of M1b the tree holds six real directories and no empty ones: `packages/api-contracts`, `packages/platform`,
`packages/core`, `packages/storage`, `packages/gateway` and `apps/cli`. `packages/storage` owns the database handle, the
migration ledger, and every statement — a route never writes SQL — and `packages/gateway` owns both halves of the HTTP
boundary: the Fastify app and `client.ts`, the fetch client with the origin-discovery rule, which lives here rather
than in `apps/cli` so the TUI, the Web bundle and the bot cannot each invent a URL (D-005). The rule that made the
split meaningful is that `apps/cli` imports `@crabby/storage` **only** for `openDatabase` and `migrate` inside
`crabby gateway start`, the one command that *is* the Gateway process; a chat command that read SQLite directly would
be the boundary violation §19 of `ARCHITECTURE.md` exists to name.

## 3. Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Gateway with `node --watch` plus built Web assets; there is no framework dev server in this project at all, which is one of the things D-068 bought (`ARCHITECTURE.md` §6.3) |
| `npm run build` | Typecheck, compile, build the Web UI as static output |
| `npm test` | `node --test 'tests/**/*.test.ts' 'packages/**/*.test.ts' 'apps/**/*.test.ts'` — unit + contract tests, fake provider only, no network. `tests/` holds the repo-level tests (the M0 harness's own, today) and gains the cross-cutting ones later |
| `npm run test:coverage` | The same run with `--experimental-test-coverage`, so CI and a laptop print the same table |
| `npm run test:integration` | Gateway + storage + task lifecycle against a temp data dir |
| `npm run test:unit` | `tests/unit/` plus each package's own runner file — the fast half, which is also the half a device cannot run and CI therefore insists on |
| `npm run format:check` | `biome format .`, the same rule `format` applies with `--write`, split out because CI must not be allowed to edit the tree it is grading |
| `npm run test:security` | The `SECURITY.md` §17 half that can be executed rather than reviewed: the route-level auth sweep, the policy surface (`packages/policy`), and the provider contract suite (`packages/providers`). It is a subset runner over the same files `npm test` globs, and it exists as its own command so a security regression can be named in one line of CI output |
| `npm run test:live` | Opt-in; hits real providers; never required for a green build |
| `npm run lint` / `npm run format` / `npm run typecheck` | Biome, chosen in D-060 (closing O-047 and O-048). The dependency name is `@biomejs/biome` — the bare `biome` package on npm is an unrelated 2016 artifact, and a `package.json` that says `biome` installs the wrong thing silently. TypeScript itself does the typecheck; Biome does not. `biome.json` excludes `probes/.deps`, `probes/out` and `docs/review/mockups` — the first two are M0's scratch installs and results, the third is generated by `build.py` and verified by its own headless checker, so linting it would lint a build artifact |
| `npm run docs:check` | `python3 scripts/check-docs.py` — planning-document lint, including the §4B review counts and the palette ratios; `npm run docs:count` runs `python3 scripts/count-inventory.py --markdown` and prints the rows to paste, and `--register-counters` prints the `DECISIONS.md` §8 counter cells — both are paste-instead-of-type because counting a register by hand has been wrong twice (F-20) |
| `npm run test:parity` | `node scripts/parity.ts` — the D-067 generator, in check mode. It compares `docs/INTERFACES_AND_API.md` §8 and §7.1 with `apps/cli/registry.ts`, every documented route with what `packages/gateway/app.ts` registers, and the tool tiers and capability vocabulary with `PROVIDERS_AND_TOOLS.md` §4.2 and `SECURITY.md` §6.1, and `AGENT_RUNTIME.md` §4.1's transition table with `PERMITTED_TRANSITIONS`. `-- --write` regenerates §8 from the rows in the script and then still fails on anything a rewrite cannot fix, which is why CI is allowed to run the write and check the diff |
| `npm run probe` / `probe:p1` … `probe:p7` | The M0 assumption probes (`probes/README.md`): one process per roadmap row, exit 0 pass, 1 measured failure, **2 blocked** when a precondition is missing. They install their own copies of Fastify, `better-sqlite3`, Ink and React under `probes/.deps/` so nothing enters the product manifest before a decision does |
| `npm run probe:results` | Rewrites the generated block in `probes/RESULTS.md` from `probes/out/*.json`. `--check` fails when the prose and the JSON disagree — the F-24 lesson, applied to the file that carries M0's numbers |
| `npm run test:termux` | `node probes/run.mjs --device`: the whole probe set plus the copy-paste checklist for the phone. Run manually before release, and in CI only if a runner exists (O-050) |

**What exists before M0 closes:** the manifest carries `test`, `test:coverage`, `test:unit`, `test:integration`,
`test:security`, `test:parity`, `lint`, `format`, `format:check`, `typecheck`, the `docs:*` trio and the `probe:*` set.
`test:integration` was added the moment `tests/integration/` had a file in it, because §3's table listed it while the
directory was empty and D-060's "commands match the manifest" rule is bidirectional: a document may not promise a
script the manifest lacks any more than the manifest may ship one that does nothing (`docs/CONSISTENCY_REVIEW.md` F-30
is the finding that made the rule bidirectional; F-32…F-35 are the same rule applied by the parity generator, which is
why `test:parity` was worth writing before `build` exists). The remaining rows above — `dev`, `build`, `test:live` —
are the commands their milestones add, and stay unlisted in `package.json` until then.

## 4. Coding Conventions

- **Naming:** `camelCase` values, `PascalCase` types, `kebab-case` files and package names. No abbreviations that a
  new contributor would have to decode; `id`, `api`, `url`, `fs`, `mcp` are fine.
- **Errors:** throw typed errors carrying a §6 `code` from `docs/INTERFACES_AND_API.md`. Never throw a string;
  never swallow an error to keep a loop alive (`AGENT_RUNTIME.md` §9.1).
- **Boundaries:** the dependency direction of `ARCHITECTURE.md` §19 is enforced by lint rules, not by review
  memory. Interfaces → contracts → services; core imports nothing from `apps/`.
- **Async:** one top-level `try/catch` per request handler; cancellation via `AbortSignal` everywhere, including
  tools and provider calls; no floating promises.
- **Zones that must stay framework-free:** policy evaluation, task state machine, approval arbitration, context budgeting. Fastify types
  must not appear inside them (D-014/`DECISIONS.md` §6 rule 01), so the framework stays swappable.
- **Erasable TypeScript only:** no `enum`, no `namespace`, no parameter properties (D-070). This is not a style rule
  a reviewer has to remember — the runtime rejects non-erasable syntax, measured here as an error from `node`
  itself, so the constraint is enforced by the platform that ships the product.
- **No new dependencies** without a note in `DECISIONS.md` explaining why the existing set cannot do it — the
  resource-conscious principle from `PROJECT_BRIEF.md` §13 has teeth in the dependency list.
- **Redaction is a constructor concern:** types that can carry a secret name it, so accidental logging is hard.
- **Comments** explain why, especially where a rule exists because of a security or Termux constraint, and reference
  the document section (`SECURITY.md §8`) so future edits do not quietly undo a decision.

## 5. Testing

| Layer | Scope | Notes |
| --- | --- | --- |
| Unit | Policy, tier computation, task state machine, context budgeting, capability resolution | Must be deterministic and network-free. `packages/agent-runtime/agent-runtime.test.ts` and `approvals.test.ts` are the state machine's and the approval arbiter's share, and both assert that every refusal cites the section that produced it |
| Contract | Every endpoint against the shared schema | `tests/integration/gateway.test.ts` drives the routes over a real socket with `@sinclair/typebox` validating both directions, which is §11's harness; the §6 class → status table is asserted as one object so a re-ordering is a failure (D-077) |
| Integration | Gateway + storage + task lifecycle + restart recovery | Temp data dirs only; never a developer's real `~/.crabby`. The same file spawns a second CLI process and a Gateway process, pairs them, and asserts that SIGTERM drains and removes `gateway.json` — the half of `probes/P-003` the plan asked a phone for, made a test instead of a report |
| Security | Deny cases, escalation, injection fixtures, redaction, auth rejection | `SECURITY.md` §17. `tests/security/policy-surface.test.ts` walks every route the Gateway prints and asserts an unauthenticated request is refused, checks that no T3 answer is reachable from a chat surface, and reads the documents for the off-by-default sentences the registry claims; `packages/policy/*.test.ts` and `packages/providers/*.test.ts` hold the rest |
| Parity | All four interfaces reach every matrix row | Blocks release. `scripts/parity.ts`, run as `npm run test:parity` |
| Platform smoke | Termux, Linux, macOS | Termux results recorded in `DECISIONS.md`, not assumed |
| Fixtures | Imported-extension samples, adversarial tool outputs, provider error bodies | Shared across interface suites so behavior cannot diverge |

Rules: a bug fix starts with a failing test; a `Proposed` decision may not be tested into `Accepted` status by
accident — validation results are written down; tests never depend on a live model API; and the fake provider
implements the same conformance suite as real adapters, so mocks cannot be easier than reality.

## 6. Commits, Branches, Reviews

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `perf:` with a scope, e.g.
  `feat(policy): deny unclassified tools at registration`.
- Small, reviewable changes. A commit that changes a decision, the document enforcing it, and its tests together
  is the ideal unit (D-034).
- Branches: `feat/<scope>-<summary>`, one purpose per branch.
- PRs use the template in §8 and must state: which document section this implements, which open decision it touches,
  and which tests prove it.
- Reviews check boundaries before style: does this bypass the Policy Engine, does it assume a provider capability,
  does it break parity, does it claim a platform it has not tested.
- No force-push to shared branches; history is a project record here, since the decision trail matters.

## 7. Documentation Workflow

- Editing any planning document requires `npm run docs:check` to pass in the same commit.
- New capability → add it to the `SECURITY.md` §6.1 vocabulary **before** a tool requests it (the checker enforces
  this).
- New decision → write the row in `DECISIONS.md` with the correct status; do not edit an `Accepted` row into
  silent disagreement elsewhere. `Superseded` is a legitimate outcome.
- Anything left undecided stays visibly undecided. "The implementation can decide later" is allowed only when it is
  written in an Open item, never in code comments.
- `docs/` holds supporting specs; root holds the documents whose rules apply to every contributor.

## 8. PR Template

```
What changes, and which document section does it implement?
Which open decisions does this touch or close? (list IDs)
How is it tested? (unit / contract / integration / security / parity / termux)
Does it add a dependency? Why can the existing set not do it?
Does it change behavior for any of the four interfaces? (if one, justify or fix parity)
Checklist:
  [ ] npm run docs:check
  [ ] npm test && npm run test:security (if security-relevant)
  [ ] DECISIONS.md updated if any status changed
  [ ] No new capability outside SECURITY.md §6.1
  [ ] Termux implications considered
```

## 9. Release and Versioning

- Semver with an honest `0.x` phase: minor bumps may break, and each break is written in the changelog with the
  migration step.
- `CHANGELOG.md` is user-facing: features, fixes, security notes, and **platform limitation changes**. Every change
  to what a platform supports is a documented change, not an implementation detail.
- Tag `v0.x.y`; publish from CI against a clean install check on Linux, macOS, and Termux.
- Data migrations ship with a tested downgrade stance: if downgrade is unsupported, say so in the changelog and in
  `crabby doctor`.
- Supported Node range and dependency licenses are re-checked at release, not only at first publish.

## 10. Debugging and Diagnostics

- `crabby doctor` is the first support step and must stay useful: environment, Node version, native module status,
  Termux constraints, vault state, listener mode, paired clients, tunnel state.
- `--log-level debug --log-file` for capture; `GET /diagnostics` is the paste-safe view, and its redaction has tests.
- On Termux, capture `logcat` context when Android killed the process; the runtime must record "terminated without
  shutdown" so a user can tell a crash from a kill.
- Replay a task from its stored events to reproduce state-machine bugs without a provider.
- Never debug with the real data dir by default: `--data-dir $(mktemp -d)` is the reflex that protects user data.

## 11. Termux Development Notes

- Test on a real device for anything touching processes, files, sockets, or signals; an emulator is not the target.
- Prefer a dedicated Termux profile for development so an experiment cannot touch a user's install.
- Assume storage is slow and space is finite: write paths are batched, and tests use temp dirs, not the home dir.
- Do not trust background longevity: any feature that needs a live process must state what happens when Android
  stops it (`PROJECT_BRIEF.md` §8, §15).
- Native modules are the classic failure point: every candidate gets the M0 P3 treatment before it is depended on.
- A CI container cannot substitute for the device here. `termux/termux-docker` runs the Node and toolchain half of the
  suite (D-060, closing O-050) — install, build, unit tests — but `termux-api` calls need Android, and TUI rendering
  needs the terminal. Those two stay on the M0 device checklist.
- Keyboard and paste behavior differ from a desktop terminal; any flow requiring a 40-character paste needs a
  shorter path or a picker.

**The M0 device loop, in one line each.** Clone the repo, `npm install`, `npm run test:termux`. The harness writes one
JSON file per probe under `probes/out/` and prints a table; `npm run probe:results` turns that into
`probes/RESULTS.md`'s measured block, whose device column is the thing `docs/ROADMAP.md` §2 is waiting for. Nothing
from a laptop run counts as that column: `probes/lib.mjs` says so in the output of every probe, on purpose (D-070).

## 12. CI

`.github/workflows/ci.yml` runs on `push` to `main`, on every pull request, and on demand. Seven legs, on
`linux-x64` and `macos-arm64` (D-060's matrix, minus what a hosted runner cannot measure):

| Leg | Command | Why it is here |
| --- | --- | --- |
| typecheck | `npm run typecheck` | TypeScript does the typecheck; Biome does not (D-060) |
| lint | `npm run lint` | `biome check .`, including the import order the Assist rules hold |
| format | `npm run format:check` | The same rule as `format`, without `--write`: CI may not edit the tree it is grading |
| test | `npm test` | Unit + contract + integration + security in one glob, over real HTTP on an OS-chosen port |
| test:security | `npm run test:security` | A leg of its own so a deny-case regression has one line of output to point at |
| test:parity | `npm run test:parity` | D-067's generator, comparing the documents with `packages/policy`, `apps/cli/registry.ts` and `packages/gateway/app.ts` |
| docs:check | `python3 scripts/check-docs.py` | Required, not advisory: it is the only thing between 22 documents and drift, and a green build with a lying document is a green build of a wrong plan |

`docs:check` also regenerates `docs/INTERFACES_AND_API.md` §8 with `npm run test:parity -- --write` and fails on the
resulting diff. That is a stronger check than comparing a table to itself: the write path still exits 1 on anything a
rewrite cannot fix, and the diff catches the one failure mode a check cannot see — someone editing the generated rows
instead of the rows in the script.

No job may require network access to a live model provider. The enforcement is boring and greppable: the workflow file
passes no `secrets:` block at all, so a test that quietly started needing a provider key fails on CI instead of becoming
a network dependency. Adding a key there has to come with a reason that survives that sentence, and the fake provider
(`PROVIDERS_AND_TOOLS.md` §3.3) run through the same conformance suite as a real adapter is why no test needs one (D-081).

**The legs that are not here, with the milestone that gives them something to run.** D-060's rule that a command in a
table is a promise about the manifest applies to a CI job as much as to an npm script, and F-30 turned it into a two-way
rule. A red job nobody can reproduce locally, or a green job that asserts nothing, both teach people to ignore CI:

| Leg | Arrives | Why not today |
| --- | --- | --- |
| `build` | M3 | There is no compilation step to run — D-070's runtime executes `.ts` entry points directly — so the script means "typecheck plus the Web bundle", and the bundle is M3's |
| `web build` | M3 | D-068 chose framework-free custom elements with no dev server; the leg needs `apps/web` to exist |
| `dev` | M3 | Gateway `--watch` plus built assets, for the same reason |
| `test:live` | M4 | Opt-in against real providers; M4 is the first milestone with adapters to point it at |
| install-from-tarball smoke | M6 | There is no release artifact until `docs/ROADMAP.md` §8 says how one is made |
| `termux` | not a hosted job, by measurement | See below |

**Why the Termux leg is not a container job.** The plan's matrix row said "`termux` via
[`termux/termux-docker`](https://github.com/termux/termux-docker)". Checking the image instead of trusting the phrase
(F-27's rule, applied to CI) turns up two facts: it is a Docker *image*, not an Action, and its own README says the
environment has no Android runtime components. So an `x86_64` container leg could verify the toolchain half — `npm ci`,
`node --test`, type resolution under bionic — and could not verify the two things that row was written for:
`termux-api` behaviour, which does not work under proot either (`termux/proot-distro`#516), and TUI rendering, which
needs a terminal of a real size. `aarch64` additionally needs `--privileged` or `seccomp:unconfined`, which a hosted
runner's container options would spend on a leg that cannot answer the question. The M0 device checklist
(`npm run test:termux`, `node probes/run.mjs --device`) is therefore the substitute for the device half, and its
results are recorded in `DECISIONS.md` rather than inferred — silence is not a pass, and neither is a pass inside a
container with no phone attached. O-050 stays open until a self-hosted ARM runner exists; adding the job then is
appending one matrix row.

## 13. Open Development Decisions

None of the six that used to sit here is open: **O-003** (npm with workspaces), **O-005** (TypeBox, because the API
contract, the config schema and the generated help all need JSON Schema as an output rather than a conversion),
**O-047**/**O-048** (Biome, as `@biomejs/biome`), **O-049** (`packages/*` unpublished in v1 — one repo, one version,
no cross-package skew to support) and **O-050** (`termux/termux-docker` for the toolchain half, device checklist for
the rest) are closed by **D-060**.

Still open, and open because they are measurements: the Node version range the Termux package actually ships and
survives (M0 P1, feeding O-002), and whether Ink 8 is fit to depend on (O-051, `docs/ROADMAP.md` §2 P5).

## 14. Development Acceptance Criteria

01. A clean clone builds and tests on Linux and macOS with a documented command sequence.
02. The same sequence is verified on Termux, with any difference documented rather than patched around silently.
03. `docs:check`, `lint`, `typecheck`, and `test` all run in CI and are all required.
04. Adding a tool, capability, endpoint, or dependency each has a documented path that includes its tests and its
    document updates.
05. No developer needs to read implementation code to learn the workflow; these files are sufficient.
06. A contributor can explain, from docs alone, why a permission denial happened — which is the real test of whether
    the security model is documented or merely implemented.

---

**End of Development Guide**
