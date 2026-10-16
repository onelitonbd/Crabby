// `crabby web open` — C8-03's row: **builds nothing, prints the URL.** D-067 decided the Web UI is served by the
// Gateway itself, on the same origin the API answers, so there is no second process to start and nothing to build —
// the only fact this command can add is *where*, which is why the URL lands on a line of its own (TUI T2-09's rule:
// a phone copies by long-press, and a URL inside a sentence is a URL that gets clipped), followed by the one hint a
// first run needs: the browser pairs with a code from `crabby auth pair`, exactly as the TUI did (§3.2's flow, the
// same identity model, no browser-specific trust mechanism).
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { readGatewayInfo } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import type { Renderer } from "../output.ts";

export async function runWebOpen(layout: DataLayout, renderer: Renderer): Promise<ExitCode> {
  const info = readGatewayInfo(layout);
  // `absent` is "nothing was ever started"; `stale` still carries the last known address, which is the one worth
  // printing — a stale gateway is restarted onto the same port by default, and a URL that needs one flag to become
  // right beats no URL at all. The state is named either way, because a silent print of a dead address is a lie.
  if (info.state === "absent") {
    renderer.line("no gateway", "nothing was ever started here, so there is no URL to open");
    renderer.fix(
      "`crabby gateway start` first — the Web UI is served by the Gateway itself (D-067)",
    );
    return EXIT.failure;
  }
  const address = info.info;
  if (info.state === "stale")
    renderer.line("note", "the gateway is not answering right now — last known address:");
  // The URL alone on its line: selectable whole, no punctuation after it.
  renderer.raw(`http://${address.host}:${String(address.port)}/web/`);
  renderer.line("", "");
  renderer.line("pair the browser", "the page asks for a pairing code on first run");
  renderer.fix("crabby auth pair --name <this browser> --interface web");
  renderer.fix("type the 8-character code into the page (single use, expires in ~2 minutes)");
  return EXIT.success;
}
