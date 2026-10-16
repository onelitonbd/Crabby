// The provider boundary M1 promised and M2/M4 filled: the contract an adapter implements (§3.1), the descriptor a
// model declares (§3.2), §3.3's configuration rules as one implementation every adapter calls, the error taxonomy and
// retry schedule every adapter shares (§3.5, D-064), the wire machinery that keeps the deadline and cancellation
// grammar from being written twice (`wire.ts`), the family adapters — `openai-compatible` (D-100), `anthropic`,
// `gemini`, `ollama` — the fake that stands in for all of them in tests (§7's "no live APIs"), and the conformance
// suite every adapter must pass (§7).
//
// `mock` stays absent on purpose: §3.3 lists it as a preset and SECURITY.md §17 lists it as the test instrument, and
// composing it from a user's config would let a task reach `completed` with no model behind it. Composition is where
// that refusal lives (`compose.ts`).

export * from "./anthropic.ts";
export * from "./compose.ts";
export * from "./config.ts";
export * from "./conformance.ts";
export * from "./contract.ts";
export * from "./descriptor.ts";
export * from "./errors.ts";
export * from "./fake.ts";
export * from "./gemini.ts";
export * from "./ollama.ts";
export * from "./openai.ts";
export * from "./override.ts";
export * from "./override-write.ts";
export * from "./wire.ts";
