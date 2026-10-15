// The provider boundary M1 promised and M2 filled: the contract an adapter implements (§3.1), the descriptor a model
// declares (§3.2), §3.3's configuration rules as one implementation both adapters call, the error taxonomy and retry
// schedule every adapter shares (§3.5, D-064), the first product adapter (`openai-compatible`, D-100), the fake that
// stands in for all of them in tests (§7's "no live APIs"), and the conformance suite every adapter must pass (§7).
//
// Three families §3.3 lists are still absent — `ollama`'s native API (model listing and pull state), `anthropic`'s
// message format and tool blocks, and `gemini`'s streaming and safety metadata — and each is absent for the reason §3.3
// gives: a vendor-specific adapter is only justified where the API genuinely differs, and none of those three differs in
// a way this build has a caller for yet. What they will find waiting is the fixture, the suite and the shared config and
// error mapping, which is the part that must not be written twice.

export * from "./compose.ts";
export * from "./config.ts";
export * from "./conformance.ts";
export * from "./contract.ts";
export * from "./descriptor.ts";
export * from "./errors.ts";
export * from "./fake.ts";
export * from "./openai.ts";
export * from "./override.ts";
