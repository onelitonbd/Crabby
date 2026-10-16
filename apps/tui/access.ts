// T14's access view, hosted in the logs pane as one more view on the `v` cycle — the review's own grouping is
// "Settings/access/logs", and the frame's six-name row (T1-02) has no seventh seat for access to sit in.
//
// The rows are the spec: two lines per client, with "connected" as a word, not a green dot (T14-01); revocation prints
// how many live streams it will end *before* it ends them (T14-03); the listener's address and its loopback state name
// what is reachable (T14-05). What this build does not have is named rather than faked, in the view itself: the
// restrict editor (T14-04) has no route — capabilities are mint-time only; tunnel (T14-06) and Telegram (T14-07) are
// M5; gateway lifecycle (T14-09) has no route; the audit jump (T14-08) has no audit route to jump to.
//
// Every line is measured against the 40-column design case before it is drawn: the confirm, the bind line and the gap
// list are written to fit it whole, because a sentence a phone cuts in half is a warning that was never given.
import { clip } from "./render.ts";

/** One paired identity as `GET /auth/clients` answers it — the contract's `ClientRecord`, read loosely because the
 *  pane reads an envelope body. */
export interface ClientRow {
  readonly id: string;
  readonly name: string;
  readonly interface: string;
  readonly capabilities: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly liveStreams: number;
}

/** Yearless dates on purpose: the full ISO stamp is the wire's business, and a 40-column frame cannot carry two of
 *  them beside a capability list. A client row is about *this* device's clients, which were made this year. */
const day = (iso: string | undefined): string => (iso === undefined ? "never" : iso.slice(5, 10));

/** T14-01's two lines. The connected word comes from the live-stream count, because the wire carries a number and two
 *  renderers deriving a boolean from it would be two definitions of connected (D-096); the count rides with the word
 *  while the width allows. */
export function clientLines(row: ClientRow, columns: number, selected: boolean): readonly string[] {
  const cursor = selected ? ">" : " ";
  const streams = row.liveStreams === 1 ? "1 stream" : `${String(row.liveStreams)} streams`;
  const connected = row.liveStreams > 0 ? `connected · ${streams}` : "not connected";
  const first = clip(`${cursor} ${row.name} (${row.interface}) · ${connected}`, columns);
  const second = clip(
    `  ${row.capabilities.join(",") || "no capabilities"} · seen ${day(row.lastUsedAt)} · made ${day(row.createdAt)}`,
    columns,
  );
  return [first, second];
}

/** T14-03's print-first, two lines: the count the revocation will end, and — when the identity is this app's own —
 *  the warning that revoking it kills this TUI's own access, which the CLI's revoke also names. */
export function revokeConfirmLines(row: ClientRow, own: boolean): readonly string[] {
  const streams =
    row.liveStreams === 0
      ? "nothing live"
      : row.liveStreams === 1
        ? "1 stream ends"
        : `${String(row.liveStreams)} streams end`;
  const lines = [`revoke ${row.id}? ${streams} · r again`];
  if (own) lines.push("! this is the identity THIS app speaks as");
  return lines;
}

/** T14-02's mint answer: the code on its own line (long-press paste, T2-09), the granted count beside it so a
 *  narrowing is checkable (§2's rule 01 needs evidence, not belief), and the host the Gateway process is on — so
 *  "local" cannot be guessed wrong over ssh. */
export function mintLines(
  mint: {
    readonly code: string;
    readonly expiresAt: string;
    readonly capabilities: readonly string[];
  },
  gatewayHost: string,
  columns: number,
): readonly string[] {
  return [
    clip(`pairing code for a client on ${gatewayHost}`, columns),
    `capabilities: ${String(mint.capabilities.length)} granted`,
    clip(`expires ${mint.expiresAt.slice(5, 16)} · single use`, columns),
    clip(mint.code, columns),
    clip("type it into the interface being paired", columns),
  ];
}

/** The whole view: the listener's line (T14-05), the clients, the carried gaps wrapped whole rather than clipped —
 *  a gap a phone cannot read is a gap it will rediscover by pressing keys. `listener` comes from `GET /diagnostics`'s
 *  `listener`, and the loopback word is the fact the address already implies. */
export function accessLines(
  clients: readonly ClientRow[],
  columns: number,
  selected: number,
  options: {
    readonly listener?: { readonly host: string; readonly port: number | undefined } | undefined;
    readonly confirmFor?: string | undefined;
    readonly mint?: readonly string[] | undefined;
    readonly ownClientId?: string | undefined;
  },
): readonly string[] {
  const lines: string[] = [];
  if (options.listener !== undefined) {
    const { host, port } = options.listener;
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    lines.push(
      clip(
        `bind ${host}:${String(port ?? "?")} · ${loopback ? "loopback only" : "NOT loopback"}`,
        columns,
      ),
    );
    if (!loopback) {
      lines.push(clip("  every device that can reach this host can drive the Gateway", columns));
    }
  }
  if (clients.length === 0) {
    lines.push("no paired clients — mint a code with n");
  }
  const first = Math.max(0, Math.min(selected - 3, clients.length - 6));
  const shown = clients.slice(first, first + 6);
  for (let index = 0; index < shown.length; index += 1) {
    const row = shown[index] as ClientRow;
    const isSelected = first + index === selected;
    lines.push(...clientLines(row, columns, isSelected));
    if (isSelected && options.confirmFor === row.id) {
      lines.push(...revokeConfirmLines(row, options.ownClientId === row.id));
    }
  }
  if (options.mint !== undefined) lines.push(...options.mint);
  lines.push(
    ...[
      "r revoke (prints first) · n mint code",
      "gaps: T14-04 restrict · T14-06 tunnel · T14-07 telegram · T14-09 lifecycle · T14-08 audit",
    ].flatMap((line) => wrapWhole(line, columns)),
  );
  return lines;
}

function wrapWhole(line: string, columns: number): readonly string[] {
  const words = line.split(" ");
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (`${current} ${word}`.length <= columns) current = `${current} ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}
