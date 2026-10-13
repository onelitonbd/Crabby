// One place that answers "how does a CLI process reach the Gateway on this machine", because four interfaces must not
// each invent their own answer (D-005). It reads, never guesses: no default port, no retry storm, no silently
// assuming a Gateway exists — `§10`'s discovery rule is that a client learns the current URL instead of storing one.
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import {
  createClient,
  type GatewayClient,
  GatewayFailure,
  readCredentials,
  readGatewayInfo,
} from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import type { Renderer } from "./output.ts";

export type Connection =
  | { state: "no-gateway" }
  | { state: "stale-gateway" }
  | { state: "paired"; url: string; client: GatewayClient }
  | { state: "unpaired"; url: string; client: GatewayClient };

export async function connect(layout: DataLayout): Promise<Connection> {
  const info = readGatewayInfo(layout);
  if (info.state === "absent") return { state: "no-gateway" };
  if (info.state === "stale") return { state: "stale-gateway" };
  const url = `http://${info.info.host}:${info.info.port}`;
  const credentials = readCredentials(layout);
  if (credentials === undefined) return { state: "unpaired", url, client: createClient({ url }) };
  // The token is used against whatever URL the Gateway published *now*, not the one stored beside it: an ephemeral
  // port means that number changes on every restart, and the identity it belongs to does not — both live in the same
  // data directory, so a pairing survives a restart exactly as far as the database does. §3.1's "re-pair on change
  // rather than trusting a stale URL" is about a *tunnel* URL, and it applies at the other end of that: when a
  // request with a stored token comes back `auth_invalid`, the client re-pairs, which `reportFailure` says.
  return { state: "paired", url, client: createClient({ url, token: credentials.token }) };
}

/** One error path for every command that talks to the Gateway, so the fix text stays identical across verbs and
 *  `--json` never gets a different truth from the human output. */
export function reportFailure(renderer: Renderer, error: unknown): ExitCode {
  if (error instanceof GatewayFailure) {
    renderer.line(`gateway said ${error.status}`, error.message);
    const code = error.envelope.error.code;
    if (code === "auth_missing" || code === "auth_invalid")
      renderer.fix("crabby auth pair --code <code> — the code the Gateway prints on its first run");
    else if (error.envelope.error.class === "validation")
      // A capability refusal gets its own next action. §3.2's promise is that failure text names one, and here
      // `--help` does not hold the answer: help prints the *shape* of a flag, while which names `--restrict` may carry
      // is SECURITY.md §6.1's vocabulary and what it may do to them is §5.3's rule. Pointing at help for that
      // would be pointing somewhere the reader cannot find the thing they were refused for.
      renderer.fix(
        hasCapabilityProblem(error.envelope.error.details)
          ? "the names are SECURITY.md §6.1's vocabulary, and a restriction may only narrow what the interface " +
              "already holds (§5.3) — leaving `--restrict` off takes the baseline"
          : "crabby <noun> <verb> --help prints the accepted shape",
      );
    else if (error.envelope.error.class === "platform-unsupported")
      // §7.1's exit `4` rather than `1`, and the fix is a configuration rather than a retry: this class is what the
      // Gateway answers with when the subsystem the verb needs was not composed in this process at all — a scheduler on a
      // Gateway that drives no tasks, a vault that does not exist yet. Nothing the caller sent is wrong, so `1` would
      // report a failure of the work when the truth is that this Gateway cannot do that here.
      renderer.fix(
        "the subsystem this verb needs is not composed in that Gateway — a scheduler on one that drives no tasks, a vault " +
          "that does not exist yet; `crabby status` and `GET /api/v1/diagnostics` say which, and what composing it takes",
      );
    else if (error.envelope.error.retryable) renderer.fix("this one is retryable — try again");
    // Three classes and not the four `exitCodeForErrorClass` maps, and the one left out is deliberate. `policy` is *not*
    // exit `3` here even though the shared table says it is: §7.1's approval row promises "a refusal prints the arbiter's
    // own sentence and exits `1`", and exit `3` is reserved for the other shape — a run *this command is blocking on*
    // parked at a prompt nobody can answer (`task run`, `job run-now`). A D-085 refusal is a refusal of the command
    // itself, so it is a failure; a parked run is an unanswered question, so it is `3`. Both readings are in §7.1 and
    // collapsing them would tell a script that its `approval approve` was waiting on a human.
    if (error.envelope.error.class === "platform-unsupported") return EXIT.platformUnsupported;
    return error.envelope.error.class === "validation" ? EXIT.usage : EXIT.failure;
  }
  renderer.line("request failed", error instanceof Error ? error.message : String(error));
  renderer.fix("crabby gateway status — is the Gateway still running?");
  return EXIT.failure;
}

export function reportNoGateway(renderer: Renderer, state: Connection["state"]): ExitCode {
  switch (state) {
    case "no-gateway":
      renderer.line("gateway", "not running — nothing has written gateway.json in this data dir");
      renderer.fix("crabby gateway start");
      return EXIT.failure;
    case "stale-gateway":
      renderer.line("gateway", "gateway.json names a pid that is gone");
      renderer.fix("crabby gateway start (it overwrites the file)");
      return EXIT.failure;
    case "unpaired":
      renderer.line("gateway", "reachable, but this client has no token");
      renderer.fix("crabby auth pair --code <code>");
      return EXIT.failure;
    default:
      return EXIT.failure;
  }
}

// Read, never guessed, in the same spirit as the discovery rule above: the envelope's `details` is an open record
// (`packages/api-contracts/error.ts:35`), so this asks whether the shape is there rather than asserting it is. A
// Gateway that sent no `kind` gets the generic fix, which is the honest answer for a refusal this build does not
// recognise.
function hasCapabilityProblem(details: Record<string, unknown> | undefined): boolean {
  const problems = details?.problems;
  if (!Array.isArray(problems)) return false;
  return problems.some((row) => (row as { kind?: unknown } | null)?.kind === "capability");
}
