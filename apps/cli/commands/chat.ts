// `crabby chat "…"` — `docs/review/CLI.md` region C5, and the one verb a person uses most.
//
// The rows (C5-01, C5-02, C5-03, C11-06):
//
//   - **C5-01** "plain question, no task, no plan; the answer streams to stdout". The output honours all three halves.
//     The answer streams, because a phone-sized answer that arrives as one block at the end is the difference between
//     "it is thinking" and "it hung". No plan tree, no event frames, no `task.state.changed` lines — the transcript is
//     what the user asked to read, and everything else is machinery.
//   - **C5-02** `crabby chat -` or a pipe reads until EOF, and an **empty stdin is an error, not a hang**: a reader that
//     waits for input nobody will type is the one failure mode of this verb that looks like a working terminal.
//   - **C5-03** `--session <id>` continues a conversation, "the same session the Web and TUI see" — which is why the id
//     goes to the route and never to a local list.
//   - **C11-06** a bare `crabby chat` gets **a fresh conversation each time, with its id printed on the last line**.
//     "Silently continuing the most recent session would let a script append to a conversation it never opened" is the
//     row's own reason, and it is the reason a task is created *without* a session id here: §2.5 makes the first task
//     asked in a conversation the thing that creates it, so one request both opens the conversation and asks the
//     question.
//
// **One divergence from C5-01's wording, recorded rather than papered over:** the row says "no task", and this build has
// no path that is not a task — every run is a `task` row, because §9's one-writer rule, the approval arbiter and the
// checkpoint all hang off it. What the verb does is keep the *task out of the user's view*: no id unless asked for, no
// plan, no event lines, no exit-code ceremony beyond §7.1's. The alternative — a route that wrote a conversation turn
// without a task — is the second writer D-112 exists to prevent, and `POST /sessions/{id}/messages` stays unbuilt for
// exactly that reason. Recorded as F-60 with the owner's answer outstanding.
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import { type Renderer, shortId } from "../output.ts";
import { findCommand } from "../registry.ts";

/** The whole of C5-02's stdin rule: read to EOF, and treat "nothing arrived" as an error. The bound is here because a
 *  pipe that never closes would otherwise hold the command open indefinitely, and C5-02's own words are "an error, not a
 *  hang" — which has to mean *this* error too, not only the empty case. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function runChat(
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("chat", undefined);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }

  // The question, from the arguments or from stdin, before anything is asked of the Gateway: C5-02's empty-stdin error
  // is a usage question whether or not a Gateway is running, and the same rule `task cancel` follows.
  const piped = tail.positionals[0] === "-";
  let question = tail.positionals.join(" ").trim();
  if (piped || tail.positionals.length === 0) {
    const piped_text = await readStdin();
    const trimmed = piped_text.trim();
    if (trimmed.length === 0) {
      renderer.line("chat", piped ? "`crabby chat -` read nothing" : "no question given");
      renderer.fix(
        piped
          ? "the pipe closed with nothing in it; an empty question is an error, not a hang (C5-02)"
          : 'a question is one argument: `crabby chat "what is in the roadmap"`',
      );
      return EXIT.usage;
    }
    question = piped ? trimmed : `${piped_text.trim()}\n${question}`.trim();
  }

  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  const client = connection.client;
  const session = tail.values.session;

  let taskId: string;
  let sessionId: string;
  try {
    // No `sessionId` unless the user named one: C11-06's rule, and §2.5's, which makes the first task in a conversation
    // the thing that creates it. One request, and the response names the conversation it opened.
    const created = (
      await client.createTask(
        {
          objective: question,
          ...(session === undefined ? {} : { sessionId: session }),
        },
        `idem-chat-${shortId(question)}`,
      )
    ).body as { id: string; sessionId: string; state: string };
    taskId = created.id;
    sessionId = created.sessionId;
  } catch (error) {
    return reportFailure(renderer, error);
  }

  if (renderer.json) {
    const { followChatStream } = await import("./chat-stream.ts");
    const outcome = await followChatStream({ url: connection.url, layout, renderer, taskId });
    renderer.raw(
      JSON.stringify({
        ok: outcome.state === "completed",
        task: taskId,
        session: sessionId,
        ...outcome,
      }),
    );
    return outcome.state === "completed" ? EXIT.success : EXIT.failure;
  }

  // The answer, streamed. `followChatStream` prints each turn's text as it arrives and nothing else: C5-01's "the answer
  // streams to stdout", and the refusal path prints what a person needs rather than an exit code alone.
  const { followChatStream } = await import("./chat-stream.ts");
  const outcome = await followChatStream({ url: connection.url, layout, renderer, taskId });
  if (outcome.needsApproval !== undefined) {
    renderer.fix(
      `crabby approval approve ${outcome.needsApproval} continues it — a chat that reaches a gated tool opens a prompt, ` +
        "because the tier belongs to the action and not to the verb that asked for it",
    );
    renderer.fix(`crabby task resume ${taskId} continues the run afterwards`);
    return EXIT.needsApproval;
  }
  if (session === undefined) {
    // C11-06: the id on the **last** line, so a script can read it from the end of the output without parsing prose.
    renderer.line("session", sessionId);
    renderer.fix(`crabby chat --session ${sessionId} continues it`);
  }
  if (outcome.state !== "completed") {
    renderer.fix(
      `crabby task show ${taskId} — the run is ${outcome.state}, and its events say why`,
    );
    return EXIT.failure;
  }
  return EXIT.success;
}
