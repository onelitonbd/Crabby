// The policy engine skeleton M1 promised. Two consumers exist today: `crabby tools ls` and `GET /api/v1/tools`, which
// publish the registry so the four interfaces in M3 have one answer to read; and the tests, which are the reason the
// escalation rules are functions rather than prose. M2's agent loop calls `evaluate` before each tool execution, in
// the order `PROVIDERS_AND_TOOLS.md` §4.4 fixes, and M2's approval service consumes the `ApprovalRequest` this module
// builds — which is why the field names here are §6.3's field names and not shorter ones.

export * from "./availability.ts";
export * from "./capabilities.ts";
export * from "./escalation.ts";
export * from "./evaluate.ts";
export * from "./paths.ts";
export * from "./record.ts";
export * from "./shell.ts";
export * from "./tiers.ts";
export * from "./tools.ts";
