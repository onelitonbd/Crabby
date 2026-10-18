// `crabby auth pair|list|revoke` — §3.1's pairing model, from the client side. The rule this file exists to keep is
// §3.2's: a code is printed on its own line so it can be pasted, and failure text names the next action.
import process from "node:process";
import {
  type ClientInterface,
  EXIT,
  type ExitCode,
  PAIRING_CODE_TTL_HINT,
} from "@crabby/api-contracts";
import { credentialsPath, readCredentials, writeCredentials } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import { parseTail, unknownFlagMessage } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

export type AuthVerb = "pair" | "list" | "revoke";

export async function runAuth(
  verb: AuthVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("auth", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(unknownFlagMessage(tail.unknown, spec));
    return EXIT.usage;
  }
  if (verb === "pair") return runPair(tail, layout, renderer);
  if (verb === "list") return runList(layout, renderer);
  if (verb === "revoke") return runRevoke(tail, layout, renderer);
  renderer.line("auth", "which verb? `pair`, `list`, `revoke`");
  return EXIT.usage;
}

async function runPair(
  tail: ReturnType<typeof parseTail>,
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const code = tail.values.code;
  // Checked before `connect`, for the ordering `task cancel` established: §7.1's exit codes are a contract about the
  // command, not about the process it would have talked to, so a malformed `--restrict` on a machine whose Gateway is
  // down still exits 2 and still says what is wrong with it. The split happens here rather than in the body because a
  // value that names nothing would otherwise reach the route, and the route refuses an empty restriction — better that
  // the user learns it from the command that mistyped the flag than from a 400 they have to read.
  const restrictRaw = tail.values.restrict;
  const restrictList =
    restrictRaw === undefined
      ? undefined
      : restrictRaw
          .split(",")
          .map((token) => token.trim())
          .filter((token) => token.length > 0);
  if (restrictRaw !== undefined && (restrictList === undefined || restrictList.length === 0)) {
    renderer.line("bad --restrict", `"${restrictRaw}" names no capability`);
    renderer.fix(
      "a comma-separated list of names from SECURITY.md §6.1 — leaving the flag off mints the baseline set, and a " +
        "restriction may only narrow it (§5.3)",
    );
    return EXIT.usage;
  }
  const connection = await connect(layout);
  if (connection.state === "no-gateway" || connection.state === "stale-gateway")
    return reportNoGateway(renderer, connection.state);

  if (code === undefined) {
    // Minting for *another* interface (a browser, Telegram) needs an existing identity: §3.1 forbids an
    // unauthenticated network caller from asking for a code, and this command is that caller until it is paired.
    if (connection.state !== "paired") return reportNoGateway(renderer, "unpaired");
    const name = tail.values.name ?? defaultName();
    const iface = (tail.values.interface ?? "web") as ClientInterface;
    try {
      const response = await connection.client.request<{
        code: string;
        expiresAt: string;
        clientId: string;
        capabilities: readonly string[];
      }>("/api/v1/auth/pair-codes", {
        method: "POST",
        body: {
          name,
          interface: iface,
          ...(restrictList === undefined ? {} : { restrict: restrictList }),
        },
      });
      renderer.line("pair as", `${name} (${iface})`);
      // Printed because the alternative is an operator believing a code carries the authority they asked for. §2's rule
      // 01 is least capability, and a number the operator can check is the cheapest evidence that a narrowing took
      // effect; `crabby auth list` prints the set itself.
      renderer.line(
        "capabilities",
        `${response.body.capabilities.length} granted` +
          (restrictList === undefined ? "" : `, narrowed from the ${iface} baseline`) +
          " — `crabby auth list` prints the set",
      );
      renderer.line("expires", `${response.body.expiresAt} — ${PAIRING_CODE_TTL_HINT}, single use`);
      renderer.line("", "");
      // The code alone, on its own line, so `crabby auth pair | tail -1` and a long-press paste both work.
      renderer.raw(response.body.code);
      renderer.line("", "");
      renderer.fix("type or paste this code into the interface you are pairing");
      return renderer.done({ ...response.body });
    } catch (error) {
      return reportFailure(renderer, error);
    }
  }

  try {
    const response = await connection.client.request<{ clientId: string; token: string }>(
      "/api/v1/auth/pair",
      {
        method: "POST",
        body: { code: code.toUpperCase() },
      },
    );
    writeCredentials(layout, {
      url: connection.url,
      token: response.body.token,
      clientId: response.body.clientId,
      pairedAt: new Date().toISOString(),
    });
    renderer.line("paired", response.body.clientId);
    renderer.line("token", credentialsPath(layout));
    renderer.line("gateway", connection.url);
    renderer.fix(
      "the token is shown once at creation and stored here; `crabby auth revoke <id>` ends it",
    );
    return renderer.done({
      clientId: response.body.clientId,
      credentialsPath: credentialsPath(layout),
    });
  } catch (error) {
    return reportFailure(renderer, error);
  }
}

async function runList(layout: DataLayout, renderer: Renderer): Promise<ExitCode> {
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  try {
    const response = await connection.client.authList();
    const items = (response.body as { items: Record<string, unknown>[] }).items;
    if (items.length === 0) {
      renderer.line("clients", "none — `crabby auth pair` mints a code for one");
      return EXIT.success;
    }
    for (const item of items) renderer.line(String(item.id), describe(item));
    return renderer.done({ items });
  } catch (error) {
    return reportFailure(renderer, error);
  }
}

async function runRevoke(
  tail: ReturnType<typeof parseTail>,
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const id = tail.positionals[0];
  if (id === undefined) {
    renderer.line("auth revoke", "which client? `crabby auth list` prints the ids");
    return EXIT.usage;
  }
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  try {
    const response = await connection.client.authRevoke(id);
    const body = response.body as { streamsEnded?: number };
    // C8-10's one line, with the count on it: "revoked" is a fact about a row, and the number is the fact about whether
    // this revocation also ended the live views the revoked identity held. The Gateway answers 200 with it precisely so
    // this line can be a report instead of a promise (D-096).
    const ended = typeof body.streamsEnded === "number" ? body.streamsEnded : 0;
    renderer.line(
      "revoked",
      `${id} · ${ended === 0 ? "no live streams to end" : `${ended} live stream(s) ended`}`,
    );
    const own = readCredentials(layout);
    if (own && own.clientId === id) {
      renderer.line("note", "that was this client's own identity — its token is now dead");
      renderer.fix(`delete ${credentialsPath(layout)} and pair again`);
    }
    return renderer.done({ revoked: id, streamsEnded: ended });
  } catch (error) {
    return reportFailure(renderer, error);
  }
}

/** Only live identities come back from `GET /auth/clients` — revocation deletes the row (see the route) — so there
 *  is no "revoked" state to render here, and a branch for it would be code for a shape the API cannot produce.
 *  §3.1's "whether it is currently connected" is the count the Gateway sends, phrased here rather than there: the wire
 *  carries a number because two renderers deriving a boolean from it is two definitions of connected (D-096). */
function describe(item: Record<string, unknown>): string {
  const caps =
    Array.isArray(item.capabilities) && item.capabilities.length > 0
      ? ` · ${item.capabilities.join(",")}`
      : "";
  const live = typeof item.liveStreams === "number" ? item.liveStreams : 0;
  const seen =
    live === 0
      ? "idle"
      : live === 1
        ? "connected, 1 live stream"
        : `connected, ${live} live streams`;
  // M5's last-seen row: an identity that authenticated but never returned reads differently from one that
  // never authenticated at all, because "this token has been sitting unused since the 14th" is a different
  // decision than "this token is in active use" — and revocation is the decision these rows feed.
  const lastUsed =
    typeof item.lastUsedAt === "string" ? ` · last seen ${item.lastUsedAt}` : " · never used";
  return `${String(item.name)} · ${String(item.interface)} · paired ${String(item.createdAt)} · ${seen}${lastUsed}${caps}`;
}

function defaultName(): string {
  return `${process.env.HOSTNAME ?? process.env.DEVICE ?? "this device"} (cli)`;
}
