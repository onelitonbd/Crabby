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
      }>("/api/v1/auth/pair-codes", { method: "POST", body: { name, interface: iface } });
      renderer.line("pair as", `${name} (${iface})`);
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
    await connection.client.authRevoke(id);
    renderer.line("revoked", id);
    const own = readCredentials(layout);
    if (own && own.clientId === id) {
      renderer.line("note", "that was this client's own identity — its token is now dead");
      renderer.fix(`delete ${credentialsPath(layout)} and pair again`);
    }
    renderer.fix(
      "live streams are not yet bound to identities, so a connected client keeps its view until it reconnects (M1c)",
    );
    return renderer.done({ revoked: id });
  } catch (error) {
    return reportFailure(renderer, error);
  }
}

/** Only live identities come back from `GET /auth/clients` — revocation deletes the row (see the route) — so there
 *  is no "revoked" state to render here, and a branch for it would be code for a shape the API cannot produce. */
function describe(item: Record<string, unknown>): string {
  const caps =
    Array.isArray(item.capabilities) && item.capabilities.length > 0
      ? ` · ${item.capabilities.join(",")}`
      : "";
  return `${String(item.name)} · ${String(item.interface)} · paired ${String(item.createdAt)}${caps}`;
}

function defaultName(): string {
  return `${process.env.HOSTNAME ?? process.env.DEVICE ?? "this device"} (cli)`;
}
