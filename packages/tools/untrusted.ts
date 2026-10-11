// `SECURITY.md` §10's structural delimiters, and the reason they carry a nonce.
//
// §10 requires that "external content is wrapped with structural delimiters and metadata (source, fetch time, trust
// label) so both the model and the audit log can attribute it", and D-065 names that marker as the user-visible half of
// its injection rule ("the `external content` marker from `SECURITY.md` §10 is what a user sees"). Neither document gave
// the marker a shape, and until an executor existed there was nothing to wrap — so the shape is decided here, in the one
// module that produces wrapped bytes, and recorded as D-098.
//
// The shape is a tag pair with a per-call nonce in it:
//
//     <external-content source="file.read" subject="notes/todos.md" trust="untrusted" at="…" nonce="a1b2c3d4e5f6">
//     …the bytes the tool did not author…
//     </external-content nonce="a1b2c3d4e5f6">
//
// The nonce is the whole design. A delimiter that content can reproduce is a delimiter content can close: a file whose
// text contains `</external-content>` would end the block early and everything after it would read as the runtime's own
// voice — which is precisely §10's "neutralize fake turn markers" requirement, arriving through a file instead of an
// import. Randomness per call makes the closer unguessable, so the content cannot forge it, and the closer repeats the
// nonce so a reader (model or human) can check the pair rather than trust the first tag that looks right. The bytes
// inside are passed through **untouched**: this is a user's file, and an executor that rewrote its contents to make them
// safe would be corrupting the thing the user asked to read. The defence is the frame, not the payload.
//
// What is *not* here: the instruction hierarchy itself (§10's precedence list), which is a prompt-assembly concern and
// belongs to whoever builds the system message; and sanitization of imported skills or memories, which §10 assigns to
// "importers" and which have no importer in this build. This module wraps tool output and nothing else.

import { randomBytes } from "node:crypto";
import { MAX_TOOL_OUTPUT_BYTES } from "@crabby/api-contracts";

/** The tag name, exported because the audit side of §10 ("so the audit log can attribute it") has to be able to look
 *  for it, and a second spelling of the same word in a second package is how a marker stops being findable. */
export const EXTERNAL_CONTENT_TAG = "external-content";

/** §10's trust label for anything a tool brought back. There is one value in this build because there is one kind of
 *  provenance a tool result can have: somebody else wrote it. A memory tool that later distinguishes "derived from
 *  untrusted content" from "the user said this" adds a label here, and `docs/DATA_AND_MEMORY.md` §7 is where that
 *  distinction already lives. */
export const TRUST_UNTRUSTED = "untrusted";

/** How many nonces are tried before the wrapper refuses. Six random bytes have 2^48 values, so a collision means the
 *  content is carrying the nonce this call just generated — which is not an accident but an attack, and the answer to an
 *  attack is a refusal rather than a ninth attempt. */
export const MAX_NONCE_ATTEMPTS = 6;

export interface UntrustedMetadata {
  /** The tool that produced the bytes. §10 asks for a source, and the tool name is the one a `tool.execution.output`
   *  event already carries, so the frame and the log agree without a translation. */
  readonly source: string;
  /** The exact target: the path read, the URL fetched. §6.3's "the audit record keeps the **exact target** in
   *  plaintext" is about approvals, and the same reason applies here — a frame that says "some file" cannot be
   *  attributed by a reader who is trying to work out what the model was persuaded by. */
  readonly subject: string;
  readonly trust?: string;
  /** ISO-8601, and §10 calls it "fetch time": when the bytes were read, not when the task started. */
  readonly at?: string;
}

export interface WrapOptions {
  /** Injectable for tests; the default is six random bytes as hex. */
  readonly nonce?: () => string;
}

export function defaultNonce(): string {
  return randomBytes(6).toString("hex");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n\t]/g, " ");
}

function attributes(meta: UntrustedMetadata, nonce: string): string {
  const parts = [
    `source="${escapeAttribute(meta.source)}"`,
    `subject="${escapeAttribute(meta.subject)}"`,
    `trust="${escapeAttribute(meta.trust ?? TRUST_UNTRUSTED)}"`,
  ];
  if (meta.at !== undefined) parts.push(`at="${escapeAttribute(meta.at)}"`);
  parts.push(`nonce="${escapeAttribute(nonce)}"`);
  return parts.join(" ");
}

/** Wrap bytes this process did not author. Throws rather than emitting an unattributable frame when the content
 *  reproduces every nonce tried (`MAX_NONCE_ATTEMPTS`), because the alternative — dropping the frame and passing raw
 *  text — is the failure §10 exists to prevent, and a refusal is loud where a silent unwrap is not. */
export function wrapUntrusted(
  meta: UntrustedMetadata,
  content: string,
  options: WrapOptions = {},
): string {
  const nonce = options.nonce ?? defaultNonce;
  for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt += 1) {
    const value = nonce();
    const open = `<${EXTERNAL_CONTENT_TAG} ${attributes(meta, value)}>`;
    const close = `</${EXTERNAL_CONTENT_TAG} nonce="${value}">`;
    if (content.includes(close)) continue;
    return `${open}\n${content}\n${close}`;
  }
  throw new Error(
    `${EXTERNAL_CONTENT_TAG}: the content reproduced ${MAX_NONCE_ATTEMPTS} generated nonces, so no delimiter this call can produce is unforgeable — refusing to emit unattributable content (SECURITY.md §10)`,
  );
}

/** §4.4's "results above the cap are truncated *and labeled* — a tool must not pretend a partial result is complete",
 *  with D-064's overflow rule attached: "64 KiB inline, larger goes to a file in the session scratch with the path
 *  printed". Both halves are here because they are one behaviour with two outputs — the model gets a bounded, labeled
 *  frame and the user keeps the whole thing for 24 hours.
 *
 *  The cap is applied to the **wrapped** text, not to the content, because the wrapped text is what leaves this module:
 *  a frame that pushed the total past 64 KiB would make the event store overflow the same bytes a second time, and two
 *  copies of one output in two scratch files is a retention decision nobody made. */
export interface CappedOutput {
  readonly text: string;
  readonly truncated: boolean;
  /** Bytes of the original content, so a caller can report the true size rather than the size of what was kept. */
  readonly bytes: number;
  /** Where the whole of it went. Absent when nothing was truncated, and absent when there was nowhere to put it — the
   *  label says which, because "truncated" and "truncated and lost" are different news. */
  readonly overflowPath?: string;
}

export interface CapOptions {
  readonly maxBytes?: number;
  /** The per-task scratch directory (D-064). Optional so a read-only caller with nowhere to put an overflow can still
   *  cap, but the label then says the bytes were dropped rather than implying they are on disk. */
  readonly overflowDir?: string;
  /** Writes the overflow file. Injected so the tests do not have to build a directory to prove a label, and so a caller
   *  that owns the scratch layout owns its permissions. */
  readonly writeOverflow?: (dir: string, content: string) => string;
  /** Passed through to `wrapUntrusted`, so one call frame and one content frame cannot disagree about a nonce. */
  readonly nonce?: () => string;
}

/** The label is the runtime's own sentence, so it sits *outside* the delimiters: §10's rule is that foreign text is
 *  inside them, and a reader who finds the label inside the frame cannot tell whether the file said it or Crabby did. */
export function labelForTruncation(result: {
  bytes: number;
  kept: number;
  overflowPath?: string;
}): string {
  const kept = `[truncated: ${result.bytes} bytes in the source, the first ${result.kept} shown above`;
  return result.overflowPath === undefined
    ? `${kept}, and the rest was dropped because no scratch directory was available]`
    : `${kept}; the whole of it is in ${result.overflowPath}, which D-064 prunes 24 h after the task ends]`;
}

export function capWrapped(
  meta: UntrustedMetadata,
  content: string,
  options: CapOptions = {},
): CappedOutput {
  const maxBytes = options.maxBytes ?? MAX_TOOL_OUTPUT_BYTES;
  const bytes = Buffer.byteLength(content, "utf8");
  const wrap = (body: string) =>
    wrapUntrusted(meta, body, options.nonce === undefined ? {} : { nonce: options.nonce });
  // Measured, not assumed: the frame's own size depends on the subject's length, so the budget for content is whatever is
  // left after an empty frame plus the longest label this function can print.
  const overhead = Buffer.byteLength(wrap(""), "utf8") + LABEL_RESERVE_BYTES;
  const budget = Math.max(0, maxBytes - overhead);
  if (bytes <= budget) return { text: wrap(content), truncated: false, bytes };

  const cut = cutAtByteBoundary(content, budget);
  const overflowPath =
    options.overflowDir === undefined || options.writeOverflow === undefined
      ? undefined
      : options.writeOverflow(options.overflowDir, content);
  const label = labelForTruncation({
    bytes,
    kept: Buffer.byteLength(cut, "utf8"),
    ...(overflowPath === undefined ? {} : { overflowPath }),
  });
  return {
    text: `${wrap(cut)}\n${label}`,
    truncated: true,
    bytes,
    ...(overflowPath ? { overflowPath } : {}),
  };
}

/** Reserved for `labelForTruncation`'s longest line. A path can be long, and the reserve is a fixed number rather than a
 *  measurement because the label is only known after the cut is made — a chicken-and-egg this constant breaks. */
export const LABEL_RESERVE_BYTES = 1024;

/** Cut on a UTF-8 boundary, because §4.4's cap is about bytes and Bengali text is three bytes a character: slicing at an
 *  arbitrary offset would put a replacement character in the model's context and a corrupt byte in the audit log. */
export function cutAtByteBoundary(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength <= maxBytes) return content;
  let end = maxBytes;
  // A continuation byte (10xxxxxx) is never the start of a character, so walking back off one lands on a boundary.
  for (;;) {
    const byte = buffer[end];
    if (end === 0 || byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}
