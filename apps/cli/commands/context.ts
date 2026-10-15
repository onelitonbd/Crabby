// `crabby context show|pin` — `docs/review/CLI.md` region C10, and the terminal's half of the context drawer the Web
// (W7), the TUI (T8-02) and Telegram (`/context`) share.
//
// These four verbs exist because the parity matrix lists them: three interfaces reach the same routes, and a user in a
// terminal has to be able to reach them too. They are also the commands a script would call, which is C10-05's reason
// for `--json`: "so a cron wrapper can stop filling a session it cannot see".
//
// What the rows asked for, and what this file does with it:
//
//   - **C10-01 `context show <session>`** — "what is in budget, what was compacted, what is pinned, each section with its
//     cost … a section costing 0 prints `0` rather than being hidden". The hidden-section question is the whole row: a
//     drawer that hides an empty section reads as "there is nothing pinned", which is a different and wrong claim. So
//     every section prints, at `0` when it is empty.
//   - **C10-02 `context pin <session> [ref]`** — one verb: no ref lists what is pinned, a ref pins it, `--remove`
//     unpins. Three jobs in one command because the row says so, and because "list / set / clear" as three verbs would
//     make a caller guess which one they wanted.
//   - **C10-03** lives on `session compact` rather than here — the row names that verb — and prints where the originals
//     live, because a compaction that left a user unsure about their history would be worse than no compaction.
//   - **C10-05 `context show --json`** — the contracts' own body, byte counts included (§3.4's units, not a token count
//     dressed as a measurement).
//
// A `ref` is a **turn ordinal** or a `first..last` range, because that is what `crabby session messages` prints and
// `GET /sessions/{id}/messages` returns. It is not a message id: an id is a machine name, and C10-02's audience is a
// person reading a transcript.
import {
  EXIT,
  type ExitCode,
  type SessionContextBody,
  type SessionPinBody,
} from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import { type Renderer, shortId } from "../output.ts";
import { findCommand } from "../registry.ts";

export type ContextVerb = "show" | "pin";

/** `first` or `first..last`, parsed here rather than by `parseTail` so a range is one token a shell will not split. */
function parseRef(text: string): { from: number; through: number } | undefined {
  const [first, last] = text.split("..");
  const from = Number.parseInt(first ?? "", 10);
  const through = last === undefined || last === "" ? from : Number.parseInt(last, 10);
  if (!Number.isInteger(from) || !Number.isInteger(through) || from < 1 || through < from) return undefined;
  return { from, through };
}

export async function runContext(
  verb: ContextVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("context", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }
  const id = tail.positionals[0];
  if (id === undefined) {
    renderer.line(
      verb === "show" ? "context show" : "context pin",
      verb === "show"
        ? "which conversation? `crabby context show <id>`"
        : "which conversation? `crabby context pin <id> [turn|range]`",
    );
    renderer.fix("`crabby session ls` prints the ids, and `crabby session messages <id>` prints the turns");
    return EXIT.usage;
  }

  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  const client = connection.client;

  try {
    if (verb === "show") {
      const body = (await client.sessionContext(id)).body as SessionContextBody;
      if (renderer.json) return renderer.done({ ...body });
      // ≤20 lines (C10-01): a header, one cost line, three sections, two closing lines. Every section prints even at
      // zero — an absent section is a claim, and "0" is the honest one.
      const cost = (label: string, section: SessionContextBody["sections"]["current"]): void =>
        renderer.line(
          label,
          `${section.chars.toLocaleString("en-US")} chars · about ${section.tokens.toLocaleString("en-US")} tokens (estimated) · ${section.turns} turn${section.turns === 1 ? "" : "s"}`,
        );
      renderer.line(
        `context ${shortId(id)}`,
        body.budget === undefined
          ? "no window is known for this conversation's model, so nothing here can be measured against one"
          : `about ${body.projected.tokens.toLocaleString("en-US")} of ${body.budget.compactAtTokens.toLocaleString("en-US")} tokens before compaction · window ${body.budget.window.toLocaleString("en-US")}, reserve ${body.budget.reserveForOutput.toLocaleString("en-US")} · threshold ${body.budget.compactAt}`,
      );
      cost("in budget", body.sections.current);
      cost("compacted", body.sections.compacted);
      cost("pinned", body.sections.pinned);
      renderer.line(
        "compacted ranges",
        body.compacted.length === 0
          ? "none"
          : body.compacted
              .map((entry) => `turns ${entry.covers.from}-${entry.covers.through}`)
              .join(", "),
      );
      renderer.line(
        "pinned ranges",
        body.pinned.length === 0 ? "none" : body.pinned.map((r) => `turns ${r.from}-${r.through}`).join(", "),
      );
      if (body.absent.length > 0)
        renderer.line("not answered here", body.absent.join(", "));
      return EXIT.success;
    }

    // C10-02: no ref lists, a ref sets, `--remove` clears.
    const ref = tail.positionals[1];
    if (ref === undefined) {
      const body = (await client.sessionContext(id)).body as SessionContextBody;
      if (renderer.json) return renderer.done({ pinned: body.pinned });
      renderer.line(
        "pinned",
        body.pinned.length === 0
          ? "none — `crabby context pin <id> <turn|first..last>` protects turns from compaction"
          : body.pinned.map((r) => `turns ${r.from}-${r.through}`).join(", "),
      );
      return EXIT.success;
    }
    const range = parseRef(ref);
    if (range === undefined) {
      renderer.line("context pin", `"${ref}" is not a turn, or is a range that ends before it starts`);
      renderer.fix("`crabby session messages <id>` prints the ordinals a ref is named in");
      return EXIT.usage;
    }
    if (tail.booleans.has("--remove")) {
      // The route names a turn by id, and removing a *range* would have to guess whether it means "everything in
      // it" or "what I added" — so the turns are looked up here, from the transcript the user is reading.
      const page = (await client.sessionMessages(id, { limit: 200 })).body as {
        items: { id: string; ordinal: number }[];
      };
      const inRange = page.items.filter((item) => item.ordinal >= range.from && item.ordinal <= range.through);
      if (inRange.length === 0) {
        renderer.line("context pin", `turns ${range.from}-${range.through} are not in this conversation`);
        return EXIT.failure;
      }
      for (const turn of inRange) await client.unpinMessage(id, turn.id);
      renderer.line("unpinned", `turns ${range.from}-${range.through} are no longer protected`);
      return EXIT.success;
    }
    const body = (await client.pinMessages(id, range)).body as SessionPinBody;
    if (renderer.json) return renderer.done({ ...body });
    renderer.line("pinned", body.note);
    return EXIT.success;
  } catch (error) {
    return reportFailure(renderer, error);
  }
}