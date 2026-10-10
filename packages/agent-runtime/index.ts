// `ARCHITECTURE.md` §18's `packages/agent-runtime`: the one runtime the four interfaces share (D-003's "one core — no
// interface implements its own agent loop"), and the zone `docs/DEVELOPMENT.md` §4 requires to stay framework-free, so
// nothing here imports Fastify, a database driver, or a provider SDK.
//
// Today it holds the task state machine (D-083). The managers the rest of M2 lists — cancellation progression,
// checkpoints, the approval service, the retry-then-ask ladder — arrive beside their own rules, and each one lands in
// this package rather than in the Gateway, because a rule the Gateway owns is a rule only the Gateway can follow.
export * from "./transitions.ts";
