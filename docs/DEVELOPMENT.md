# Crabby — Development Guide

> **Document status:** Planning draft. Written before code exists, so the workflow is a specification rather than a
> description of habits.
>
> **Related:** `docs/ROADMAP.md`, `AGENTS.md`, `ARCHITECTURE.md` §18/§19, `DECISIONS.md`

## 1. Environment

| Requirement | Version / note |
| --- | --- |
| Node.js | LTS; supported range pinned by M0 P1 and recorded in `DECISIONS.md` (O-002 context: reports tested v22.x–v26.x on Termux) |
| Package manager | npm with workspaces (P-005) unless O-003 changes it after the Termux comparison |
| TypeScript | `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; ESM only |
| Runtime | `tsx` for development; compiled output for release; no postinstall scripts in Crabby packages |
| Native toolchain (Termux) | `pkg install python make clang` for `better-sqlite3` source builds — documented, and checked by `crabby doctor` |
| Editor | Any; `tsconfig` and lint config are the contract, not a specific IDE |

`engines.node` in the root `package.json` is authoritative. Anything that only works on the developer's machine is
a bug, and on this project "the developer's machine" may be a phone.

## 2. Repository Layout

Per `ARCHITECTURE.md` §18. Practical rule: create a package only when it holds code and has a real owner; the
proposed tree is a map, not a checklist. `packages/api-contracts` is the only package every interface may import
from, and interface apps never import core internals directly.

## 3. Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Gateway with watch mode plus built Web assets; never requires a Vite dev server for the backend (`ARCHITECTURE.md` §6.3) |
| `npm run build` | Typecheck, compile, build the Web UI as static output |
| `npm test` | Unit + contract tests, fake provider only, no network |
| `npm run test:integration` | Gateway + storage + task lifecycle against a temp data dir |
| `npm run test:security` | `SECURITY.md` §17 suite |
| `npm run test:live` | Opt-in; hits real providers; never required for a green build |
| `npm run lint` / `npm run typecheck` | Biome or ESLint+Prettier, chosen once and recorded (O-047) |
| `npm run docs:check` | `python3 scripts/check-docs.py` — planning-document lint |
| `npm run test:parity` | Parity test over `docs/INTERFACES_AND_API.md` §8 |
| `npm run test:termux` | The above on-device; run manually before release, and in CI only if a runner exists |

## 4. Coding Conventions

- **Naming:** `camelCase` values, `PascalCase` types, `kebab-case` files and package names. No abbreviations that a
  new contributor would have to decode; `id`, `api`, `url`, `fs`, `mcp` are fine.
- **Errors:** throw typed errors carrying a §6 `code` from `docs/INTERFACES_AND_API.md`. Never throw a string;
  never swallow an error to keep a loop alive (`AGENT_RUNTIME.md` §9.1).
- **Boundaries:** the dependency direction of `ARCHITECTURE.md` §19 is enforced by lint rules, not by review
  memory. Interfaces → contracts → services; core imports nothing from `apps/`.
- **Async:** one top-level `try/catch` per request handler; cancellation via `AbortSignal` everywhere, including
  tools and provider calls; no floating promises.
- **Zones that must stay framework-free:** policy evaluation, task state machine, context budgeting. Fastify types
  must not appear inside them (D-014/`DECISIONS.md` §6 rule 01), so the framework stays swappable.
- **No new dependencies** without a note in `DECISIONS.md` explaining why the existing set cannot do it — the
  resource-conscious principle from `PROJECT_BRIEF.md` §13 has teeth in the dependency list.
- **Redaction is a constructor concern:** types that can carry a secret name it, so accidental logging is hard.
- **Comments** explain why, especially where a rule exists because of a security or Termux constraint, and reference
  the document section (`SECURITY.md §8`) so future edits do not quietly undo a decision.

## 5. Testing

| Layer | Scope | Notes |
| --- | --- | --- |
| Unit | Policy, tier computation, task state machine, context budgeting, capability resolution | Must be deterministic and network-free |
| Contract | Every endpoint against the shared schema | Generated from `api-contracts`, per `docs/INTERFACES_AND_API.md` §11 |
| Integration | Gateway + storage + task lifecycle + restart recovery | Temp data dirs only; never a developer's real `~/.crabby` |
| Security | Deny cases, escalation, injection fixtures, redaction, auth rejection | `SECURITY.md` §17 |
| Parity | All four interfaces reach every matrix row | Blocks release |
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
- Keyboard and paste behavior differ from a desktop terminal; any flow requiring a 40-character paste needs a
  shorter path or a picker.

## 12. CI

Matrix: `linux-x64`, `macos-arm64`, `termux-arm64` (when a runner is practical, otherwise a documented manual
checklist). Jobs: `typecheck`, `lint`, `test`, `test:security`, `test:parity`, `docs:check`, `build`,
`web build`, and an install-from-tarball smoke test. No job may require network access to a live model provider.

Until a runner exists for Termux, the M0 checklist in `docs/ROADMAP.md` §2 is the manual substitute and its results
are recorded in `DECISIONS.md` — silence is not a pass.

## 13. Open Development Decisions

Recorded in `DECISIONS.md`: **O-003** (npm vs pnpm), **O-005** (Zod vs TypeBox), **O-047** (linter/formatter
choice), **O-048** (Biome vs ESLint+Prettier vs none — overlaps O-047, resolve together), **O-049** (whether
`packages/*` are published independently or only as app bundles), **O-050** (CI Termux runner approach).

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
