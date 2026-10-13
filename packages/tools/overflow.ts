// D-064's second half, in the one place it is implemented: "64 KiB inline, larger goes to a file in the session scratch
// with the path printed". `capWrapped` in `./untrusted.ts` decides *whether* a result is over the cap and prints the
// label that names the path; writing the bytes is this file's job, and it is a separate module because two executors
// now need it and a rule with two implementations is a rule that drifts — the file tools overflow a user's own bytes,
// and `net.fetch` overflows a stranger's, which is the same permission question with a sharper answer.
//
// What is decided here, and why it is decided once:
//
//   - **Mode 0600, in a directory `taskScratch` already created 0700.** The overflow is a verbatim copy of content this
//     task was allowed to obtain — a file inside a workspace root, or a response body from a host the arbiter priced —
//     and a second copy with looser permissions would be a new fact about the state directory that nobody approved. The
//     directory's `0700` is `docs/DATA_AND_MEMORY.md` §4.1's own row for `scratch/<taskId>/`; a file inside it inherits
//     that as a floor, and 0600 keeps the copy narrower than the directory that holds it.
//   - **It names itself.** §4.1 names the *other* thing that lands in this directory — `<eventId>.json`, the payload
//     `packages/storage/events.ts` spills when an event is over `MAX_EVENT_PAYLOAD_BYTES`. A tool result is written
//     before any event carries it, so there is no id to take a name from, and the caller supplies a directory and never
//     a filename: a tool argument that reached this path would be a way to write outside the scratch directory, which is
//     §8's containment question arriving through a filename instead of a path.
//   - **Synchronous.** The writer is called from inside the framing of a result that is already in memory, and the label
//     printed beside the frame has to name the path the write produced. An asynchronous write would mean either a label
//     that guesses or a framing step that awaits, and `capWrapped` is deliberately a pure function of its arguments.
import { writeFileSync } from "node:fs";
import path from "node:path";

/** Writes one over-cap tool result into the task's scratch directory and returns the path the label prints. The
 *  signature is `CapOptions.writeOverflow`'s, so `capWrapped` is handed this function rather than a copy of it. */
export function writeOverflowFile(dir: string, content: string): string {
  const file = path.join(
    dir,
    `tool-output-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  return file;
}
