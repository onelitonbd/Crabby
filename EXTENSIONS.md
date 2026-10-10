# Crabby — Extension, Skills, Plugins, and Compatibility Specification

> **Document status:** Planning draft. Format and flow are proposed requirements; the isolation mechanism remains
> a validation gate (`DECISIONS.md` O-008).
>
> **Owns:** extension taxonomy, manifest contract, installation and compatibility pipeline, external harness
> import boundaries, MCP integration rules.
>
> **Does not own:** permission tiers and approval semantics (`SECURITY.md` §6), tool runtime state
> (`AGENT_RUNTIME.md`), storage of extension metadata (`docs/DATA_AND_MEMORY.md`).
>
> **Related:** `ARCHITECTURE.md` §14, `SECURITY.md` §11, `PROJECT_BRIEF.md` §9

## 1. Purpose

Define how Crabby gains capabilities after it ships: what an extension is, how it is described, how Crabby
decides whether it can run on the current platform, and how extensions written for other harnesses (OpenClaw,
Claude Code, MCP-based tooling) are imported safely.

The governing constraint from `PROJECT_BRIEF.md` §9 and `DECISIONS.md` D-013: **external extensions are never
assumed to run unchanged.** Compatibility is a per-format, per-capability claim, made by a checker, not an
optimistic default.

The governing constraint from the owner's direction: this must stay **lightweight**. Crabby will not build a
large plugin framework, a package registry, or an OS sandbox before a first release justifies them.

## 2. Design Principles

01. **Data before code.** The most valuable and most portable extensions are inert content (skills, prompts,
    command templates, MCP configuration). They get implemented first; executable code gets implemented last.
02. **One contract, narrow surface.** A single native extension interface, small enough to document on one page.
    A capability that cannot be expressed through the contract belongs in the core, not in a plugin.
03. **Declare, don't discover.** An extension must state its needs — capabilities, dependencies, host API
    version — so the host never has to guess, and never grants ambient authority.
04. **Deterministic checks first, AI second.** Validation is rule-based; the model explains, suggests, and
    scaffolds. An AI verdict is never a security decision (`SECURITY.md` §2 rule 07).
05. **Import is translation, not execution.** Adopting a foreign format produces a Crabby-local artifact with its
    own permissions. The foreign format does not obtain runtime rights by existing on disk.
06. **Honest rejection.** If Crabby cannot run something, it says so plainly, names the missing requirement, and
    offers the alternatives it found. Silent degradation to a "best effort" mode is prohibited.
07. **Mobile budget.** Installation size, memory footprint, and startup cost are measured against low-resource
    Android devices, since every installed extension loads into the same single process as the Gateway
    (`ARCHITECTURE.md` §5).
08. **Uninstall must actually remove.** Code, capabilities, and residual data are all accounted for on removal.

## 3. Extension Taxonomy

| Kind | What it is | Executable? | First release |
| --- | --- | --- | --- |
| **Skill** | Instructions, procedures, and templates that shape how the agent works (Markdown + frontmatter). | No | Yes |
| **Command template** | A named, parameterized prompt or task recipe, invocable from any interface. | No | Yes |
| **MCP server reference** | A connection to an external MCP server exposing tools, resources, prompts. | Remote/child process | Yes (client only) |
| **Tool** | A callable capability with a validated input schema. | Yes | First-party only; third-party blocked (O-008) |
| **Provider adapter** | Implements the provider interface for a model service. | Yes | Built-ins only; third-party blocked (O-008) |
| **Event hook** | Reacts to lifecycle events (task started, tool finished, approval denied). | Yes | Deferred — needs isolation |
| **Interface integration** | Adds or customizes a surface (e.g. a dashboard panel, a channel adapter). | Yes | Deferred |
| **Theme / preset pack** | Design tokens or configuration presets. | No | Yes |

Everything inert (rows 1–3, 8) is safe to support early because it cannot execute; it is still *untrusted
content* under `SECURITY.md` §10 and cannot become instructions that override policy.

Initial release scope, confirmed: **skills + command templates + MCP client + first-party tools/providers**.
Third-party executable kinds (Tool, Provider adapter, Event hook, Interface integration) are blocked until
`O-008` passes, and a blocked kind must be reported as "not supported yet in this version" rather than
silently failing to load.

## 4. Package Layout and Manifest

### 4.1 Directory shape

```
crabby-extension/
├── crabby.extension.json      # manifest, required
├── README.md                  # human documentation
├── skills/
│   └── report-writing/SKILL.md
├── commands/
│   └── release-notes.md
├── mcp/
│   └── servers.json           # MCP server configuration
├── src/                       # only for executable kinds
│   └── index.ts
└── assets/
```

Single-file extensions are legal: a folder containing only `SKILL.md` plus frontmatter is a valid skill package.

### 4.2 Manifest fields

The manifest is versioned so that future format changes are explicit rather than inferred.

| Field | Required | Purpose |
| --- | --- | --- |
| `manifestVersion` | yes | Schema version of the manifest itself. |
| `id` | yes | Stable reverse-DNS identifier, e.g. `dev.crabby.skill.report-writing`. |
| `name`, `description` | yes | Human-facing; `description` is model-visible and therefore untrusted content. |
| `version` | yes | Extension's own version. |
| `kind` | yes | One of §3. |
| `hostApi` | yes | Minimum and maximum supported Crabby host API version. |
| `capabilities` | no | Requested permissions using the `SECURITY.md` §6.1 vocabulary. Empty means "content only". |
| `entrypoint` | for executable kinds | Module to load and the exported activation symbol. |
| `dependencies` | no | Runtime dependencies with version ranges; used by the compatibility checker. |
| `platforms` | no | Restriction list (e.g. `["android-termux","linux"]`). Absence means "unstated", *not* "all". |
| `resources` | no | Requested limits: memory, CPU time, output size, network host set. |
| `riskHint` | no | Author's own tier guess. Advisory only — an extension cannot self-assign below the floor (`SECURITY.md` §6.2). |
| `license` | yes | SPDX identifier; drives §9 licensing checks. |
| `integrity` | publisher-provided | Hash or signature for §8 verification. |
| `compatibility` | no | Provenance block when this artifact was imported/converted (source harness, source path, conversion report reference). |

Validation requirements: unknown fields are rejected with a message (not ignored) so typos cannot silently
disable a declared capability; `id` collisions with an installed extension require an explicit decision; the
manifest parser must enforce size and depth limits to avoid pathological input.

### 4.3 Skill frontmatter fields

A skill is the one kind that often arrives without a manifest, so its frontmatter is its manifest and the field set
is a contract (D-071). The upstream Agent Skills format defines `name`, `description`, and optionally `license`,
`compatibility`, `metadata`, and an experimental `allowed-tools`; Crabby treats each in one of three ways, because
"we can read this" and "we trust this" are different questions.

| Field | Required | Treatment | Rule |
| --- | --- | --- | --- |
| `name` | yes | Honored | 1–64 characters, lowercase letters, digits and single interior hyphens, and **equal to the containing folder name**. A mismatch is a hard error, not a warning: the name is the install key, and a skill that installs under a name its folder denies is two sources of truth. |
| `description` | yes | Honored, untrusted | 1–1024 characters, expected to state what the skill does and when to use it. It is model-visible, therefore untrusted content under `SECURITY.md` §10 — the field that decides activation is the field an author can lie in, and every interface that lists skills shows it as quoted author text, not as a system statement. |
| `license` | no | Honored | SPDX identifier, or free text naming a bundled license file. Absence is a warning, not a block: the ecosystem ships both, and refusing an otherwise valid skill over metadata would push users toward disabling the check. |
| `compatibility` | no | Displayed, not enforced | Free prose about the environment the author tested. Shown on the install screen and copied into the conversion report. Crabby does not parse it, and no behavior changes because a skill claims compatibility with something. |
| `metadata` | no | Honored only for known keys | `version`, `author`, `tags`, and namespaced `crabby.*` keys are interpreted. Any other key is preserved verbatim and not read — a field we do not understand must survive a round trip so a later version can understand it. |
| `allowed-tools` | no | **Recorded, never granted** | See the note below. |
| anything else | no | Ignored loudly | One named line in `ext validate` and the conversion report. |

`allowed-tools` is the interesting one, and the reason this table exists. In the upstream format it pre-approves tools
for the skill, read from a file that Crabby has no reason to trust — the format's own security notes describe a
harness where such a line applies even in an untrusted folder, letting a repository's skill grant itself broad shell
access before anyone approves it. Crabby maps the names into the `SECURITY.md` §6.1 vocabulary **for reporting only**:
they appear in the capability diff, and a skill requesting them is flagged for review at install. An approval tier is
never skipped because a file asked to be exempt from approvals; that would move the security decision into the payload
(§1.3). A user who wants fewer prompts gets them from `--restrict` plus remembered decisions owned by Crabby
(`SECURITY.md` §6.3), not from an author's frontmatter.

Body size, which the format leaves to implementations: over 500 lines is a validation **warning** recommending a split,
and a body over 32 KiB is **refused at activation** with the instruction to move material into `references/`. Truncating
instructions is the one thing a skill loader may never do — a truncated rule reads exactly like a complete one, and the
model will follow the part that survived.

Native manifests stay strict where imported skills are lenient, and that asymmetry is deliberate: a `crabby.extension.json`
rejects unknown fields so a typo cannot silently drop a declared capability, while an imported `SKILL.md` records and
preserves what it does not understand (§11 rule 3), because rejecting someone's upstream file for carrying a field
dated after this release is how an import path becomes useless.

### 4.4 Host API version policy

`hostApi` in the manifest (min and max) is the mechanism; this is the policy it implements (D-072).

* One version pair, `major.minor`, for the whole host API surface — not one per capability. Per-capability versions
  would need a resolver, and a resolver is where "works on my host" goes to hide.
* `minor` bumps are additive: a new optional method, a new field in a result. A bundle whose `max-host-api` is below
  the running minor still loads, because nothing it called changed.
* `major` bumps mark anything that changes a signature, a meaning, or a security-relevant default. A bundle whose
  `min-host-api` exceeds the host **refuses to load** with `ext_host_api_unsupported`, naming both versions in the
  message. "Half-loaded, some calls failing" is the failure mode this prevents.
* v1 ships exactly one major. Supporting two live majors is a maintenance promise this project cannot keep on a
  phone-sized codebase, and an honest refusal costs one error message.
* Deprecation is a three-step ladder with at least one release between steps: `@deprecated` plus the replacement's
  name in a minor → a warning line in `ext check-compat` and in the load report in the next minor → removal at the
  following major. There is deliberately no release changelog before the first release, so the authoritative record of what is
  deprecated is `ext check-compat` output, which every interface can surface — a command is harder to leave stale than a file.
* Skills without a manifest take the current minor implicitly, and a converted skill records the resolved pair in its
  conversion report, so "what did this assume when it was imported" stays answerable years later (D-039).

## 5. Lifecycle

States: `discovered → validated → installed → enabled → active → suspended → disabled → uninstalled`, with
`rejected` and `quarantined` reachable from `validated`.

| Transition | Requirement |
| --- | --- |
| discovered → validated | Manifest parse, schema check, integrity check, static inspection, capability diff, platform fit. |
| validated → installed | Approval per `SECURITY.md` §6.2 (install is T2, executable kinds T3). |
| installed → enabled | Explicit user action for anything with `capabilities` or `entrypoint`. |
| enabled → active | Activation happens at Gateway start or on enable; failure to activate must disable the extension and report why — never leave a half-loaded extension. |
| active → suspended | Automatic on resource-limit breach, repeated crash, or host API mismatch after an upgrade. |
| any → uninstalled | Removes code, revokes capabilities, reports residual data (`SECURITY.md` §11). |

The Extension Manager records lifecycle transitions as events, so any interface can show what happened and when
(`ARCHITECTURE.md` §9).

## 6. Compatibility Pipeline

The checker runs before installation and is re-run on update, host upgrade, and on demand.

```
User requests install (any interface)
   |
   v
[1] Format detection ....... native manifest? SKILL.md? plugin.json? .mcp.json?
   |
[2] Structural validation .. schema, size limits, path traversal inside archive, symlink handling
   |
[3] Integrity .............. signature/hash where available, publisher identity
   |
[4] Declared requirements ... host API range, dependencies, platform list, resources
   |
[5] Environment probe ...... current Node.js version, OS/arch, Termux detection, presence
   |                        of required external binaries, native build feasibility
   |
[6] Static safety scan ..... dangerous command patterns, capability requests vs declared behavior,
   |                        embedded instructions targeting the agent, archive bombs
   |
[7] Deterministic verdict .. compatible | partial | incompatible | unsafe
   |
[8] AI-assisted layer (optional, advisory)
   |     · explains why something failed in plain language
   |     · suggests equivalent Crabby-native or already-installed extensions
   |     · proposes an adaptation for portable content (skill/command rewrite)
   |     · offers to scaffold a native stub the user must then approve
   v
[9] User decision .......... install · import content-only · cancel
```

Rules that keep this honest:

- Step 8 output **cannot** change a step 7 verdict from reject to accept. It can only annotate and propose.
- A "partial" verdict must enumerate exactly which features are unavailable, not merely warn.
- Content-only import is always offered when the package has inert parts, so users are not forced to accept code
  to use instructions.
- The checker must be reproducible: same artifact + same environment yields the same verdict, which is what makes
  it testable (`§13`).
- On Termux, native build feasibility is part of the verdict — a dependency that needs glibc prebuilds is
  "needs source build", and missing toolchain is a *named, fixable* reason rather than a generic failure.

### 6.1 Verdict semantics

| Verdict | Installation outcome | Runtime state |
| --- | --- | --- |
| compatible | Proceeds after required approval | Fully enabled |
| partial | Proceeds only with explicit acceptance of the listed gaps | Enabled with disabled features recorded |
| incompatible | Rejected, unless a content-only subset exists | Quarantined (files kept, nothing loads) |
| unsafe | Rejected outright; no "install anyway" path in the initial release | Quarantined with reason |

There is deliberately no "install anyway, at your own risk" escape hatch for `unsafe` while isolation is
unresolved (O-008). Adding one is a security decision, not a convenience flag.

## 7. Capabilities and Trust

- Each extension is a **separate permission principal**. Grants are stored per extension id, never inherited from
  the user's or the task's authority.
- Requested capabilities are validated against §6.1 of `SECURITY.md`; unknown capability names fail closed.
- The permission prompt shows a **diff** for updates: added capabilities are highlighted, and any addition of
  `shell.run`, `shell.privileged`, `net.egress`, `ext.execute`, `config.write`, `tunnel.enable`, or `device.*`
  requires fresh explicit approval.
- Extensions receive a filtered host API object, not module-level access to the core. Anything not exposed does
  not exist for them.
- Long-lived "remember this choice" grants are unavailable to extensions classified T3, mirroring `SECURITY.md` §6.
- An extension that requests no capabilities still may not instruct the agent to exceed the user's own
  permissions; its content sits at the lowest tier of the instruction hierarchy.

## 8. Trust Tiers and Integrity

| Tier | Source | What Crabby assumes | Isolation requirement |
| --- | --- | --- | --- |
| **bundled** | Ships inside Crabby repository | Reviewed with the release | In-process load permitted |
| **first-party** | Official Crabby packages | Same maintainers, separately versioned | In-process load permitted |
| **verified-community** | Publisher identity + integrity match | Code not read by maintainers | O-008 gate — isolation required before activation |
| **unverified** | Any other source (git URL, local path, archive) | Nothing | O-008 gate; content-only import allowed today |

The initial release ships with only `bundled` and `first-party` able to carry executable code. Content from any
tier may be imported as a skill. **Confirmed by the project owner:** no third-party executable tool, provider
adapter, hook, or interface integration is enabled in the first release — not behind a warning, not behind an
advanced flag. The only path from "I want this extension" to "it runs" for third-party code is the O-008
isolation gate passing first. A `verified-community` tier needs a signing/integrity story that actually works
without a hosted registry — which is why registries are deferred (§15), and why the tier table above is a policy
for later, not a promise of a marketplace now.

Archive handling requirements (all tiers): reject absolute paths and parent traversal, refuse symlinks pointing
outside the extraction root, cap uncompressed size and file count, and never execute a bundled install script
during installation.

## 9. Dependencies and Licensing

- Extensions must declare runtime dependencies; Crabby must not run an unmanaged `npm install` silently as part of
  "install extension". Dependency resolution is an explicit, reported, and approval-gated step.
- On Termux, any dependency with a native build step must state its build prerequisites (compiler, `python`,
  `make`) and be reported as "needs source build" so a user on a phone knows what to expect
  (`DECISIONS.md` §5.4).
- Prefer zero-dependency extensions; the Extension Manager reports install size and dependency count before
  approval.
- License review: an `MIT`-licensed Crabby may not bundle GPL/AGPL-licensed code or assets without a review, and
  importing an extension never grants redistribution rights. `crabby ext info <id>` must display the license and
  any attribution requirement.
- Third-party extension *compatibility* does not license Crabby to copy another project's branding, icons, or
  implementation (`PROJECT_BRIEF.md` §14).

## 10. MCP Integration

MCP is Crabby's preferred route to the outside tool world, because it is a defined boundary instead of a bespoke
adapter per service.

**Client (initial release):**

- Configuration import from a documented `servers.json` shape and from foreign equivalents (§11).
- Two transports only at first: stdio child process (local binary) and remote HTTP/SSE. Both must surface the
  actual command line or URL in the approval prompt (`SECURITY.md` §11).
- Discovered tools are registered in the shared tool registry, tier-classified by the Policy Engine's rules, and
  their results are untrusted content.
- A server that fails to start, or disconnects mid-task, produces a clear task-visible error — not an empty tool
  list.
- Server output sizes, timeouts, and call rates are capped by Crabby, not by the server's own defaults.

**Server role (the opposite direction — other AI tools calling *into* Crabby): rejected (D-040).** Crabby is an
MCP client only and does not expose itself as an MCP server. Rationale: it does not serve the primary use case
(operating an agent from a phone), it multiplies the inbound attack surface for every deployment, and it would
require a second authentication and approval story with weaker UX than the four interfaces already have.

If this is ever revisited, the design must start from these constraints — served through the same Policy Engine,
no widening of what an approval grants, an explicitly enabled and separately authenticated endpoint, and never
exposing `config.write` or `shell.*` merely because a client asked. None of that is a reason to build it now.

**MCP is not a trust level.** An MCP server is an unverified third party by default and inherits the §8 rules.

## 11. External Harness Compatibility

Adapters are built in this priority order, matching the direction recorded in `ARCHITECTURE.md` §14.

| Phase | Target | Import scope | Explicitly out of scope |
| --- | --- | --- | --- |
| C-1 | Portable `SKILL.md` instruction packs | Markdown body + the honored fields in §4.3 (`name`, `description`, `license`, `compatibility`, `metadata.version`/`author`/`tags`); `allowed-tools` is read for the capability diff and never granted | Hooks, model overrides, tool-result plumbing |
| C-2 | MCP server configuration files | Server definitions, transport settings, env var *names* (never values) | Automatic approval of any server |
| C-3 | Claude Code packages | Skills, slash-command definitions, agent descriptions as content | Executable hooks, host-API plugins, LSP integrations |
| C-4 | OpenClaw bundles | Skills, tool references, plugin metadata as descriptors | Anything requiring an equivalent host runtime Crabby lacks |
| C-5 | Demand-driven formats | Assessed individually via this same table | Unassumed formats |

Conversion requirements:

1. Every conversion produces a **conversion report**: what was mapped, what was dropped, what was reinterpreted,
   and what remains unknown.
2. The report is stored with the artifact (manifest `compatibility` block) and is queryable from any interface.
3. Unsupported constructs are **preserved in the source form inside the imported folder** but never loaded, so a
   later Crabby version may support them without the user re-downloading anything.
4. Frontmatter fields that encode host behavior (e.g. permission lists, model selection, tool allow-lists) are
   translated only when there is a genuine Crabby equivalent; otherwise they are recorded as ignored, loudly.
5. Imported content passes through the same §6 step 6 scan as a native package.
6. An importer must never claim "compatible" for a whole package because some files converted cleanly — the
   verdict is per capability.
7. Import must not modify the original source directory.

Non-goals for this area: running another harness's plugins in-process, emulating a foreign host API surface,
maintaining bidirectional sync, or promising ongoing compatibility with formats that change upstream.

## 12. Authoring Support

The lightweight promise applies to developers too:

- `crabby ext init [name] --kind skill|tool|provider|mcp-config [--from <path>]` scaffolds a valid manifest,
  README stub, and minimum files. With `--from`, it converts an existing skill/command folder.
- `crabby ext validate [path]` runs the deterministic checker and exits non-zero on any error — usable in CI.
- `crabby ext check-compat [path] --explain` runs the checker and, on failure, adds the AI-assisted explanation
  and alternatives (advisory text only).
- `crabby ext info <id>` shows manifest, granted capabilities, license, source tier, conversion report, and last
  activation errors.
- Skills are authorable without writing code at all; that is the primary path, documented first.
- `crabby ext update <id> [--all]` re-runs validation and re-prompts on permission changes;
  `crabby ext uninstall <id> [--purge-data]` separates "keep my data" from "delete everything".

Extension authors follow `AGENTS.md`; the generated scaffold includes a `CONTRIBUTING`-style note so agents can
extend the project without inventing contract details.

## 13. Persistence and Metadata

Stored through the storage abstraction (`docs/DATA_AND_MEMORY.md` §5), logically an extension repository holding:

- Installed extension records: id, version, kind, source tier, install path, integrity value, enabled state.
- Capability grants, per extension and per version.
- Validation results and the full conversion-report history per version, so a verdict is re-readable after a
  restart and an update never destroys the record of what the previous version could not do.
- Activation history and suspension reasons for diagnostics.

Extension data lives in a per-extension data directory, removed or reported on uninstall. Extension code and data
are never written inside the Crabby installation directory, keeping upgrades and reinstalls safe.

## 14. Testing Requirements

- **Fixture-based compatibility tests:** each fixture has an expected verdict. At minimum: valid native skill;
  valid native executable; manifest with unknown field; traversal-bearing archive; symlink escape; oversized
  archive; missing dependency; platform-restricted package; glibc-prebuild-only native dependency (must report
  "needs source build"); and a `unsafe` pattern case.
- **Converter tests:** for each format in §11, golden-file conversion reports proving that dropped features are
  reported rather than silently ignored.
- **Policy tests:** extension cannot self-lower tier; capability request fails closed on unknown names; a
  permission diff is required before an added `shell.run`; a quarantined extension never loads.
- **Isolation tests (after O-008):** prove a restricted extension cannot reach `fs`, `net`, or `child_process`
  outside its granted capabilities, and prove that a crash or runaway loop suspends only that extension.
- **Update/uninstall tests:** verify revocation and residual-data reporting.
- All tests must run without live model APIs and, for the platform cases, on Termux itself.

## 15. Open Decisions

Recorded and tracked in `DECISIONS.md`:

| Topic | Status |
| --- | --- |
| Plugin isolation and supported trust levels (**O-008**) | Needs Validation. Candidate ordering: (1) in-process with filtered API for bundled/first-party only; (2) child-process execution with a capability RPC for everything else. `worker_threads` is documented as *insufficient* for security isolation and therefore not a mitigation. On Termux, `node:vm` is likewise not a security boundary. Gate: untrusted executable code stays off until a candidate passes a hostile-extension test. |
| Extension registries | **Decided as a v1 non-goal (D-035, D-050).** Install-by-path and install-by-git-URL only, so no index service, no moderation queue, no availability dependency. Revisit only when there is a publisher to be accountable to (O-064). |
| Native extension format for third parties (**follow-on of O-008**) | Open. Contract drafted here; publication of a stable third-party API waits for the isolation decision. |
| Event-hook capability surface | Deferred with isolation (**O-008**): the surface cannot be sized before it is known which process may hold it. |
| Extension API versioning policy | **Decided (D-072).** Declared as one `major.minor` pair in `hostApi`, additive changes bump the minor and never break a bundle, breaking changes bump the major and refuse to load, deprecated in three steps. §4.4. |
| Skill frontmatter field set (feeds **O-021**) | **Decided as a field list (D-071), §4.3.** The rule behind it was already settled: D-065 closed O-021 by deciding imported text is data, tagged by source and never parsed as an instruction. Recording an ignored field is a requirement rather than a nicety — silence is what makes a user believe a `permissions:` line did something — which is why every unknown key, and `allowed-tools` in particular, produces a named line in the report. |
| Signing/integrity mechanism for `verified-community` | Open as **O-064**; must not require a hosted service, and the tier stays unofferable until the mechanism and its revocation story exist. |
| Sandbox on Termux | Needs Validation as **O-065**: practical options are limited (`SECURITY.md` §15); M0 P7 measures it, and the fallback is a documented platform limitation, not a claim. |
| MCP server role | **Decided: non-goal (D-040).** Crabby is a client only. |
| Conversion-report history depth | **Closed by D-065** (O-027), accepted earlier in D-039 as retained and diffable: the report for the installed version and the one before it are kept, older ones are pruned, and both ship inside user exports. Two versions is the whole answer to "when did this start failing", and unbounded retention would only be an answer to storage pressure. |

## 16. Acceptance Criteria

This specification is ready for implementation planning when:

01. The manifest schema is finalized as a versioned contract with a validating parser.
02. The compatibility pipeline has a deterministic verdict function that is testable without a model.
03. The taxonomy is reduced to what the first release actually supports (skills, commands, MCP client,
    first-party tools/providers) with the rest explicitly deferred.
04. Every capability an extension can request maps to the `SECURITY.md` §6.1 vocabulary.
05. Import verdicts are provably conservative: unknown means rejected, not best-effort.
06. The C-1 and C-2 conversions are specified well enough that no implementer must invent field mappings.
07. O-008's gate is written down as a hard block on untrusted executable loading, not a preference.
08. `DECISIONS.md` reflects every accepted and open item above, and `EXTENSIONS.md` references no rule that
    `DECISIONS.md` does not know about.

---

**End of Extension Specification**
