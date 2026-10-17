// `crabby tunnel` — §13's lifecycle in three verbs. `on` is the T3 act: it prints which paired identities
// become remotely reachable (the sentence §13 requires the enabling surface to say) and asks before it spawns;
// `off` revokes exposure for real (§13: the listener closes, not the URL alone); `status` reads the live state
// from the Gateway rather than remembering anything — D-066's "clients must discover rather than assume" is
// also a CLI rule, because the URL a terminal remembers from yesterday is a URL that no longer exists.
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { Response } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";

const VERBS = ["on", "off", "status"] as const;

export async function runTunnel(
  verb: string,
  args: string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  if (!(VERBS as readonly string[]).includes(verb)) {
    renderer.line("tunnel", `which verb? one of ${VERBS.join(", ")}`);
    return EXIT.usage;
  }
  void args;
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);

  if (verb === "status") {
    const status = (await connection.client.status()).body as {
      subsystems: { tunnel?: { state: string; url?: string; reason?: string } };
    };
    const tunnel = status.subsystems.tunnel;
    renderer.line("tunnel", tunnel?.state ?? "unknown");
    if (tunnel?.url !== undefined) renderer.line("url", tunnel.url);
    if (tunnel?.reason !== undefined) renderer.line("note", tunnel.reason);
    return renderer.done(tunnel ?? {});
  }

  if (verb === "on") {
    // The T3 confirmation, with §13's required text: the identities that become remotely reachable.
    const clients = (await connection.client.authList()).body as {
      items?: { name: string; interface: string }[];
    };
    const reachable = clients.items ?? [];
    renderer.line(
      "tunnel on",
      "a Quick Tunnel gives reachability — not authentication, not availability",
    );
    renderer.line(
      "auth",
      "every route still answers the token; a wrong token gets 401, tunnel or not",
    );
    for (const identity of reachable) {
      renderer.line(`  reachable: ${identity.interface}`, identity.name);
    }
    if (!process.stdin.isTTY && !args.includes("--yes")) {
      renderer.fail({
        code: "approval_required",
        message:
          "enabling a tunnel is T3 — pass --yes (or run it from a terminal to be asked) after reading the list above",
      });
      return EXIT.needsApproval;
    }
    if (process.stdin.isTTY && !args.includes("--yes")) {
      renderer.line("confirm", "type `yes` to open the tunnel, anything else to stop");
      const answer = await readConfirm();
      if (answer.trim().toLowerCase() !== "yes") {
        renderer.line("tunnel on", "stopped — nothing was opened");
        return EXIT.success;
      }
    }
    let answer: Response<unknown>;
    try {
      answer = await connection.client.request("/api/v1/tunnel", {
        method: "POST",
        body: { confirm: true },
      });
    } catch (error) {
      return reportFailure(renderer, error);
    }
    const body = answer.body as { url: string };
    renderer.line("url", body.url);
    renderer.fix(
      "the URL changes on every start — hand out the one this command printed, never an older one",
    );
    return renderer.done(body);
  }

  // off
  let _answer: Response<unknown>;
  try {
    _answer = await connection.client.request("/api/v1/tunnel", { method: "DELETE" });
  } catch (error) {
    // A Gateway with no tunnel answers 404: the honest reading of "off" when nothing is on.
    const code = (error as { envelope?: { error?: { code?: string } } }).envelope?.error?.code;
    if (code === "not_found") {
      renderer.line("tunnel off", "no tunnel was active");
      return renderer.done({ stopped: false });
    }
    return reportFailure(renderer, error);
  }
  renderer.line(
    "tunnel off",
    "stopped — the listener is closed, the old URL answers nothing from here",
  );
  return renderer.done({ stopped: true });
}

async function readConfirm(): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question("", resolve);
  });
  rl.close();
  return answer;
}
