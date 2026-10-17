# Extensions — Crabby v1 packages overview

Crabby v1 ships four first-party extension packages. None of them are loaded
dynamically at runtime; they are maintained in-repo, versioned and released with
the host, and their behaviors are covered by deterministic tests.

| Package | Location | Purpose | Loaded via |
|---|---|---|---|
| Memory tools | `packages/tools/memory.ts` | `memory.save` / `memory.search` / `memory.delete` tool surfaces | gateway composition at startup |
| Telegram bot | `apps/telegram` | owner-facing bot over the same gateway | long-poll process |
| CLI | `apps/cli` | `crabby` command (config, jobs, logs, extensions) | user shell |
| Web | `apps/web` | local dashboard | served by the CLI/gateway |

First-party only: the v1 release contains **no third-party runtime extension
loading**. Third-party extensions arrive as inert content packages and are
validated by the checker in `packages/extensions` before anything is installed;
executable kinds are refused (D-038).
