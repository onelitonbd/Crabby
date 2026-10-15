// `ARCHITECTURE.md` §18's `packages/agent-runtime`: the one runtime the four interfaces share (D-003's "one core — no
// interface implements its own agent loop"), and the zone `docs/DEVELOPMENT.md` §4 requires to stay framework-free, so
// nothing here imports Fastify, a database driver, or a provider SDK.
//
// Today it holds the task state machine (D-083), the approval arbiter that settles §6.3's answers (D-084), the loop that
// calls `policy.evaluate` before every action and opens the request a gated one needs (D-086, D-087, D-088), the
// cancellation manager that records §6.1's request and writes §6.2's evidence (D-089, D-090), the retry ladder D-043
// priced inside the loop's provider path (D-094), the recovery scan that decides what a restart may and may not resume
// (D-092), the checkpoint D-065's resume rule reads (D-095), and the write-phase discipline those share (`journal.ts`).
// The managers the rest of M2 lists — context budgeting, and the runner that would drive a task — arrive beside their own
// rules, and each one lands in this package rather than in the Gateway, because a rule the Gateway owns is a rule only
// the Gateway can follow.
//
// `loop-harness.ts` is deliberately not exported here: it composes this package with the fake provider and an executor
// that records instead of acting, which is a test instrument and not part of the surface another package should build
// on. It is reachable by subpath (`@crabby/agent-runtime/loop-harness.ts`) for the suites and for a reviewer who wants
// to watch a task go through the gate.
export * from "./approvals.ts";
export * from "./cancellation.ts";
export * from "./checkpoint.ts";
export * from "./context.ts";
export * from "./cron.ts";
export * from "./journal.ts";
export * from "./loop.ts";
export * from "./messages.ts";
export * from "./recovery.ts";
export * from "./runner.ts";
export * from "./scheduler.ts";
export * from "./transitions.ts";
