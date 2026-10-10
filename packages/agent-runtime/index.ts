// `ARCHITECTURE.md` §18's `packages/agent-runtime`: the one runtime the four interfaces share (D-003's "one core — no
// interface implements its own agent loop"), and the zone `docs/DEVELOPMENT.md` §4 requires to stay framework-free, so
// nothing here imports Fastify, a database driver, or a provider SDK.
//
// Today it holds the task state machine (D-083), the approval arbiter that settles §6.3's answers (D-084), and the loop
// that calls `policy.evaluate` before every action and opens the request a gated one needs (D-086, D-087, D-088). The
// managers the rest of M2 lists — cancellation progression, checkpoints, the retry-then-ask ladder — arrive beside their
// own rules, and each one lands in this package rather than in the Gateway, because a rule the Gateway owns is a rule
// only the Gateway can follow.
//
// `loop-harness.ts` is deliberately not exported here: it composes this package with the fake provider and an executor
// that records instead of acting, which is a test instrument and not part of the surface another package should build
// on. It is reachable by subpath (`@crabby/agent-runtime/loop-harness.ts`) for the suites and for a reviewer who wants
// to watch a task go through the gate.
export * from "./approvals.ts";
export * from "./loop.ts";
export * from "./transitions.ts";
