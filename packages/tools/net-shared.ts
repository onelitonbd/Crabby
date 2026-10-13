// The parts of `net.fetch` and `http.request` that are about a *destination* rather than about a verb, in one file
// instead of two. §4.2 splits those two rows for a reason that has nothing to do with this file — the tier cell and
// the idempotency declaration differ — and this file holds the four properties that must not differ, because a redirect
// rule with two copies is a rule with two answers:
//
//   - `SCHEMES`: `http:` and `https:` only, checked on the request and again at every hop.
//   - the same-host redirect rule: the arbiter priced one host, so a hop that changes it is a destination nobody priced.
//   - the bounded hop count (§5.2's one clock for a chain, D-106's five hops).
//   - `cappedRead`: the download stops at the cap instead of reading a stranger's body whole onto a phone.
//
// `net.ts` is the older of the two and was written with these four inline; this file exists because the second executor
// needed them and copying them would have made the property "both rows refuse a cross-host redirect" a fact about two
// pieces of text rather than about one function. Moving them is not a refactor for its own sake — it is what makes
// `http.request`'s own header comment ("shared with `net.ts` rather than re-derived") true.
import type { ToolOutcome } from "@crabby/agent-runtime";

/** The two schemes both executors serve, as a shared constant because the same two are checked on the way in and at
 *  every redirect hop, and a hop checked against a different list than the request is a rule with a hole in the middle. */
export const SCHEMES: readonly string[] = ["http:", "https:"];

/** D-106's five hops. The number is about how many requests one pricing buys rather than about a client's default:
 *  §5.2 gives the whole chain one clock and §4.3 priced one host, so a chain of same-host hops is one act repeated.
 *  Undici's own default is twenty, which is a transport's patience and not a policy's. */
export const MAX_REDIRECTS = 5;

export interface CappedBody {
  readonly text: string;
  /** Bytes taken off the wire, which is what the report names: after a cut inside a multi-byte character this is a
   *  little more than the text holds, and the difference is the half a character this executor chose not to read. */
  readonly readBytes: number;
  readonly cutAtSource: boolean;
}

/** Reads at most `maxBytes` of a response body and stops, rather than reading all of it and letting `capWrapped` cut
 *  afterwards. The difference is memory on a phone: the file tools can read a whole file because those bytes are the
 *  user's and already on the device, while a response body is a stranger's and its length is theirs to choose. The
 *  stream is cancelled rather than left open, because an unread body keeps a connection alive and §5.2's one clock does
 *  not cover a socket this executor decided to stop reading from. */
export async function cappedRead(response: Response, maxBytes: number): Promise<CappedBody> {
  if (response.body === null) return { text: "", readBytes: 0, cutAtSource: false };
  const reader = response.body.getReader();
  // Streaming decode, so a cut that falls inside a multi-byte character leaves the partial sequence undecoded instead of
  // turning it into a replacement character: §4.4's cap is about bytes and Bengali text is three bytes a character,
  // which is the same reason `cutAtByteBoundary` exists on the framing side.
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let readBytes = 0;
  let cutAtSource = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const room = maxBytes - readBytes;
      const take = value.byteLength <= room ? value : value.subarray(0, Math.max(0, room));
      readBytes += take.byteLength;
      text += decoder.decode(take, { stream: true });
      if (readBytes >= maxBytes) {
        cutAtSource = true;
        break;
      }
    }
    // Flushed only when the stream ended on its own: a flush after a deliberate cut would emit a replacement character
    // for the half a character this executor chose not to read.
    if (!cutAtSource) text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text, readBytes, cutAtSource };
}

export function parseUrl(url: string, base?: URL): URL | undefined {
  try {
    return base === undefined ? new URL(url) : new URL(url, base);
  } catch {
    return undefined;
  }
}

/** §4.1's refusal shape for a URL that is not one, carrying the reason §6.3 asks for. A discriminated result rather
 *  than a refusal thrown and caught, because both executors need "parsed or the sentence" and neither needs the other. */
export type ParsedUrl = { url: URL } | { refused: ToolOutcome };

export function parseOrRefuse(
  url: string,
  tool: string,
  code: string,
  base?: URL,
): ParsedUrl {
  const parsed = parseUrl(url, base);
  if (parsed !== undefined) return { url: parsed };
  return {
    refused: {
      ok: false,
      code,
      output:
        `'${url}' is not a URL this executor can parse, so there is no host for policy to have priced and nothing to ` +
        `send. An absolute \`http:\` or \`https:\` URL is what §4.1's schema for \`${tool}\` asks for.`,
    },
  };
}

/** The runtime's own sentence about a completed exchange, outside the frame (§10: a reader who found Crabby's
 *  commentary inside the delimiters could not tell which of the two said it). Both rows print one; the parts are the
 *  row's own facts, because a shared tail with per-row middles would be a template nobody could read. */
export function noteHeader(tool: string, parts: readonly string[]): string {
  return `${tool}: ${parts.join("; ")}.`;
}
