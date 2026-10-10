// The provider interface of §3.1, and the metadata that makes it checkable. The table's "Kind" column is not
// documentation decoration: `conformance.ts` reads `PROVIDER_METHODS` to assert that an adapter actually implements
// every required member, and a new member added to the document has to be added here, where forgetting it fails a test.
//
// §3.1's opening sentence is the contract this file is built around — "Presence of a method is not enough; the
// capability must be declared in `describe()`" — which is why `cancellation` is a descriptor field and `cancel` an
// optional method, and why the conformance suite checks the two agree in both directions. A provider that has `cancel`
// but declares `unsupported` is lying about being unable to stop; one that declares `supported` without the method
// would have the runtime wait for a request the document says it can abort.

import type { ModelDescriptor, SupportedFeature } from "./descriptor.ts";
import type { ProviderError } from "./errors.ts";

export const PROVIDER_METHODS = [
  {
    member: "id",
    kind: "required",
    contract: "Stable provider identifier used in configuration and audit records",
  },
  {
    member: "describe",
    kind: "required",
    contract: "Capability descriptor per §3.2, plus limits; cached and re-checked on config change",
  },
  {
    member: "listModels",
    kind: "required",
    contract: "Model list with per-model limits and capabilities; MAY be static",
  },
  {
    member: "generate",
    kind: "required",
    contract: "Single completion; text plus usage; MUST honor ctx.signal",
  },
  {
    member: "stream",
    kind: "required",
    contract: "Async iterator of deltas; same terminal states as generate",
  },
  {
    member: "cancel",
    kind: "optional",
    contract: "Best-effort abort; absence means the runtime waits for the request to settle",
  },
  { member: "countTokens", kind: "optional", contract: "Estimator; absent means §3.4 estimation" },
  {
    member: "validateConfig",
    kind: "required",
    contract: "Rejects unusable configuration with an actionable reason before any call",
  },
] as const satisfies readonly {
  readonly member: string;
  readonly kind: "required" | "optional";
  readonly contract: string;
}[];

export type ProviderMember = (typeof PROVIDER_METHODS)[number]["member"];
export const REQUIRED_METHODS: readonly ProviderMember[] = PROVIDER_METHODS.filter(
  (m) => m.kind === "required",
).map((m) => m.member);
export const OPTIONAL_METHODS: readonly ProviderMember[] = PROVIDER_METHODS.filter(
  (m) => m.kind === "optional",
).map((m) => m.member);

export type ProviderRole = "system" | "user" | "assistant" | "tool";

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ProviderMessage {
  readonly role: ProviderRole;
  readonly content: string;
  readonly toolCalls?: readonly ProviderToolCall[];
  readonly toolCallId?: string;
}

/** A tool offered to the model. `name` is the tool registry's name, so §4.4's order of checks starts before the
 *  provider sees anything: an adapter receives only tools policy has already cleared. */
export interface ProviderToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ProviderRequest {
  readonly modelId: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ProviderToolSpec[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export type StreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly type: "done"; readonly usage: Usage; readonly finishReason: FinishReason }
  | { readonly type: "error"; readonly error: ProviderError }
  | { readonly type: "cancelled" };

/** The three terminal states §3.1 names. `error` and `cancelled` are terminal *streams*, not thrown values, so a
 *  consumer that stops reading on the first event cannot mistake a truncated answer for a finished one. */
export type FinishReason = "done" | "length" | "tool-calls" | "content-filter";

export interface GenerateResult {
  readonly text: string;
  readonly usage: Usage;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly finishReason: FinishReason;
}

export interface CancellationHandle {
  readonly requestId: string;
}

export interface ProviderContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
  /** The runtime enforces deadlines (§3.1: "Timeouts are enforced by the runtime wrapper"), so an adapter reads these
   *  rather than deciding its own. */
  readonly timeoutMs?: number;
  readonly attempt?: number;
  readonly taskId?: string;
}

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type ConfigValidation = { ok: true } | { ok: false; reason: string };

export interface Provider {
  readonly id: string;
  describe():
    | Promise<Readonly<Record<string, ModelDescriptor>>>
    | Readonly<Record<string, ModelDescriptor>>;
  listModels(): Promise<readonly string[]> | readonly string[];
  generate(request: ProviderRequest, ctx: ProviderContext): Promise<GenerateResult>;
  stream(request: ProviderRequest, ctx: ProviderContext): AsyncIterable<StreamEvent>;
  cancel?(handle: CancellationHandle): Promise<void> | void;
  countTokens?(text: string): number;
  validateConfig(config: ProviderConfig): ConfigValidation;
}

/** §3.1's rules for every method, kept next to the interface they constrain so a reviewer of the interface sees them.
 *  Two of the four are assertions the conformance suite can run; the other two are about what an adapter must *not*
 *  do, and are checked where the capability exists. */
export const PROVIDER_RULES: readonly string[] = [
  "Timeouts are enforced by the runtime wrapper, so a hung provider cannot occupy a task forever",
  "Errors are translated into the taxonomy in §3.5; raw provider bodies are preserved in the audit record with secrets stripped",
  "A provider must not be able to alter the tool set, permission state, or approval outcome of a task",
  "Adapters must not persist conversation content outside the request unless a provider-side feature is explicitly enabled by the user",
];

/** The rule behind rule three, expressed as a check: a completion may propose tool calls, and only that. A provider
 *  response carrying a field that would change permissions is refused here rather than ignored, because the tempting
 *  implementation of "ignore unknown fields" is the same line of code that ignores a `policy` field. */
export const FORBIDDEN_RESPONSE_FIELDS = [
  "capabilities",
  "tier",
  "approvals",
  "permissions",
  "allowedTools",
  "systemPrompt",
] as const;

export function assertNoPrivilegedFields(
  response: Readonly<Record<string, unknown>>,
): { ok: true } | { ok: false; field: string } {
  for (const field of FORBIDDEN_RESPONSE_FIELDS) {
    if (Object.hasOwn(response, field)) return { ok: false, field };
  }
  return { ok: true };
}

export function supportsFeature(descriptor: ModelDescriptor, feature: SupportedFeature): boolean {
  return descriptor.supports[feature];
}
