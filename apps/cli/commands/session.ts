// `crabby session ls|new|rename|compact` — `docs/review/CLI.md` region C11 over the conversation routes
// `docs/INTERFACES_AND_API.md` §4.3 has that this build answers. Every verb is HTTP and none of them opens SQLite, for the
// reason `commands/job.ts` gives: §19's rule is that an interface may request, display and relay, and a second reader of
// the session table would be a second opinion about what a conversation's state word means.
//
// C11's own sentence is why the noun exists at all: "`chat --session <id>` continues a session but cannot *find* one.
// Without `session ls` the only way to resume on a phone is to remember an id, which is how people end up with forty
// sessions they cannot tell apart."
//
// Two things the noun does not have, both by decision:
//
//   - **No `session delete`** (C11-05). Destroying a conversation is `history delete-session`, T3 per §4.2 and typed-back
//     per W15-07, so there is exactly one command that destroys history and one place to look for it. A `session delete`
//     here would be a second path to the same irreversible act, reachable from a noun whose other verbs are harmless.
//   - **`session show` stays planned** (C11-03), and there is no branch for it in this file: the dispatcher answers a
//     planned verb from its registry row, in one place, with the milestone that row names. Its content is "title, turns,
//     tasks, budget, pinned items", and three of those five need a message store and D-027's context manager that do not
//     exist; `GET /api/v1/sessions/{id}` names the absence in its `absent` list rather than answering `0 turns` for a
//     conversation that has forty, and a verb that printed the same zeroes would be printing them at a person.
import {
  type CompactSessionBody,
  EXIT,
  type ExitCode,
  type SessionActionBody,
  type SessionDetailBody,
  type SessionListBody,
  UNNAMED_TITLE,
} from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import { clip, type Renderer, shortId } from "../output.ts";
import { findCommand } from "../registry.ts";

export type SessionVerb = "ls" | "new" | "show" | "rename" | "compact";

const ORIGINS = ["cli", "tui", "web", "telegram"] as const;

export async function runSession(
  verb: SessionVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("session", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }

  const origin = tail.values.origin;
  if (verb === "ls" && origin !== undefined && !(ORIGINS as readonly string[]).includes(origin)) {
    renderer.line("bad --origin", `"${origin}" is not an interface`);
    renderer.fix(
      `${ORIGINS.join(" | ")} — W15-11's four, and leaving the flag off lists all of them`,
    );
    return EXIT.usage;
  }

  // C11-04's title arrives as one positional after the id, quoted by the shell. Taken whole rather than joined from the
  // remaining words, because a title with two spaces in it is a title and a verb that collapsed them would be editing
  // what the user typed.
  const title = verb === "rename" ? tail.positionals[1] : undefined;
  if (verb === "rename") {
    if (tail.positionals[0] === undefined) {
      renderer.line("session rename", "which session? `crabby session ls` prints the ids");
      renderer.fix(
        "a conversation is created by the first task asked in it, or by `crabby session new`",
      );
      return EXIT.usage;
    }
    if (title === undefined || title.trim() === "") {
      renderer.line(
        "session rename",
        'a title is required: `crabby session rename <id> "the title"`',
      );
      renderer.fix(
        "the title replaces the whole of the old one — it is what `session ls`, the Web sidebar and the TUI switcher " +
          "print (W15-04, T16-05)",
      );
      return EXIT.usage;
    }
  }
  if (verb === "new") {
    const fromFlag = tail.values.title;
    if (fromFlag !== undefined && fromFlag.trim() === "") {
      renderer.line("bad --title", "a title is text with something in it, or the flag stays off");
      renderer.fix(
        `with no title the session is created ${UNNAMED_TITLE} and takes its title from the first task asked in it ` +
          "(W15-03)",
      );
      return EXIT.usage;
    }
  }

  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  const client = connection.client;

  try {
    if (verb === "ls") {
      const body = (await client.sessions({ ...(origin === undefined ? {} : { origin }) }))
        .body as SessionListBody;
      if (renderer.json) return renderer.done({ ...body });
      if (tail.booleans.has("--quiet")) {
        // Ids and nothing else, one per line: §10's scripting contract, so a shell that means to pipe them into
        // `xargs -I{} crabby task ls --session {}` does not have to cut five columns out of every line first.
        for (const session of body.items) renderer.raw(session.id);
        return EXIT.success;
      }
      if (body.items.length === 0) {
        renderer.line(
          "sessions",
          `none${origin === undefined ? "" : ` created from ${origin}`} — a conversation is created by the first task ` +
            "asked in it, so a fresh install has none",
        );
        renderer.fix(
          '`crabby session new` creates one on purpose, and `crabby task run "…"` creates one by using it',
        );
        return EXIT.success;
      }
      // C11-01's six fields on one line each, in its order, with the state word in the label column so a list greps by
      // state without a second tool. The order is the route's — last activity, newest first — and the row says so rather
      // than leaving a reader to infer it from the first line.
      for (const session of body.items)
        renderer.line(
          session.stateWord,
          `${clip(session.titleShown, 28)}  ${session.lastActivityAt}  ` +
            `${session.tasks} task${session.tasks === 1 ? "" : "s"}` +
            `${session.runningTasks > 0 ? ` (${session.runningTasks} moving)` : ""}  ` +
            `${session.model ?? "default model"}  ${session.origin ?? "unknown origin"}  ` +
            `${shortId(session.id)}`,
        );
      const waiting = body.items.filter((row) => row.stateWord === "waiting-approval").length;
      if (waiting > 0)
        renderer.fix(
          `${waiting} conversation(s) have work stalled on a human: \`crabby approval ls\` prints the prompts ` +
            "(W16-02's rule that this state is never hidden applies to a list of conversations too)",
        );
      return EXIT.success;
    }

    if (verb === "new") {
      const fromFlag = tail.values.title;
      const created = (
        await client.createSession({
          ...(fromFlag === undefined ? {} : { title: fromFlag }),
        })
      ).body as SessionActionBody;
      if (renderer.json) return renderer.done({ ...created });
      // C11-02's contract in one line, and the second half of it is the part that matters: "prints the id and the command
      // to use it — a created thing you cannot address is a bug".
      renderer.line("session", `${created.session.id}`);
      renderer.fix(
        created.session.title === undefined
          ? `created ${UNNAMED_TITLE}: the title becomes the first question asked in it (W15-03) — ` +
              `\`crabby chat --session ${created.session.id}\` continues it`
          : `crabby chat --session ${created.session.id} continues it`,
      );
      return EXIT.success;
    }

    if (verb === "rename" && title !== undefined) {
      const id = tail.positionals[0] as string;
      // Read, then write with the token the read carried: §2's concurrency row, and the reason the CLI does two requests
      // where a `--force` flag would do one. Two interfaces can edit a title inline at the same moment (W1-02, W15-04,
      // T16-05), and the loser of that race has to be told it lost.
      const current = (await client.session(id)).body as SessionDetailBody;
      const patched = (await client.patchSession(id, { title }, current.session.revision))
        .body as SessionActionBody;
      if (renderer.json) return renderer.done({ ...patched });
      renderer.line("renamed", `${shortId(id)} → "${patched.session.titleShown}"`);
      return EXIT.success;
    }

    if (verb === "compact") {
      const id = tail.positionals[0];
      if (id === undefined) {
        renderer.line("session compact", "which session? `crabby session ls` prints the ids");
        renderer.fix(
          "compaction folds a conversation's older turns into one summary; the turns stay readable",
        );
        return EXIT.usage;
      }
      const body = (await client.compactSession(id)).body as CompactSessionBody;
      if (renderer.json) return renderer.done({ ...body });
      // Three answers, three sentences, and the sentence comes from the contracts — the same refusal wording the
      // Web and Telegram screens read, because four interfaces writing four explanations of one refusal is four
      // chances to say something different about the same conversation.
      renderer.line(`compact ${body.outcome}`, body.note);
      return EXIT.success;
    }

    renderer.line("session", "which verb? `ls`, `new`, `rename` or `compact`");
    renderer.fix(
      "`show` is planned and there is deliberately no `delete`: destroying a conversation is " +
        "`crabby history delete-session`, so there is one command that does it and one place to look (C11-05)",
    );
    return EXIT.usage;
  } catch (error) {
    return reportFailure(renderer, error);
  }
}
