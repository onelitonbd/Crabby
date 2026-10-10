// The provider boundary M1 promised: the contract an adapter implements (§3.1), the descriptor a model declares
// (§3.2), the error taxonomy and retry schedule every adapter shares (§3.5, D-064), the fake that stands in for all of
// them in tests (§7's "no live APIs"), and the conformance suite every adapter must pass (§7).
//
// No real adapter lives here yet, and that is the plan rather than an omission: `openai-compatible`, `ollama`,
// `anthropic`, and `gemini` arrive in M2 with the agent loop that calls them (docs/ROADMAP.md §4), and what they will
// find waiting is the fixture and the suite that today define the shape.

export * from "./conformance.ts";
export * from "./contract.ts";
export * from "./descriptor.ts";
export * from "./errors.ts";
export * from "./fake.ts";
