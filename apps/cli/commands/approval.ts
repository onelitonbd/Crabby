// `crabby approval ls|approve|deny` — §7.1's Approvals row, over the two §4.3 routes that have been registered since the
// approval service was composed into the Gateway: `GET /approvals` sweeps before it reads (D-093, because a deadline that
// passed while nobody was looking expired the row by the clock and not by anybody's opinion) and `POST
// /approvals/{id}/decision` answers through the same arbiter a runtime would. What was missing was the terminal, and the
// consequence was concrete rather than cosmetic: `crabby status` could print "N waiting" while no command could answer
// one, so a prompt raised over HTTP could only be answered over HTTP. Cancellation had reached all four interfaces and
// approval had reached none of them, which is the same "one behaviour, four surfaces" rule broken at the other end —
// three interfaces could stop work and not one could authorise it.
//
// Two flags this verb deliberately does not accept, because a flag with nothing behind it is a promise the code cannot
// keep:
//
// * No `--scope`. `ApprovalDecisionBody` types `scope` as a string rather than the literal `"once"` on purpose, so that
//   D-052's refusal of a remembered approval arrives from the arbiter citing §6.3 rather than from a schema that never
//   lets the request through — and the HTTP surface already has a test that provokes exactly that refusal. This release
//   admits one answer shape, so a flag whose every non-default value is a refusal would advertise an override that does
//   not exist. That is the opposite of `--mode` on `task cancel`, where the override is real and leaving it unreachable
//   from a terminal would have made §6.2 advice rather than a button.
// * No `--yes`, and no `--reason` on `deny`. An explicit `approval approve <id>` is already the confirmation, so a flag
//   that skips a prompt would advertise a prompt no code asks; and the decision body carries no reason field at all, so a
//   reason typed at a terminal would be dropped on the floor — silently losing the one thing the user offered is worse
//   than not asking for it. What the record does hold is §14's audit fields (`actor`, `via`, `outcome`), written by the
//   route from the identity that answered, which is the honest answer to "why" that this release can give: who, from
//   where, and what they decided.
import { APPROVAL_STATES, EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import { clip, type Renderer, shortId } from "../output.ts";
import { findCommand } from "../registry.ts";

export type ApprovalVerb = "ls" | "approve" | "deny";

/** The rows of §4.3's queue as this command reads them. Typed here rather than imported from `@crabby/agent-runtime`,
 *  whose `ApprovalRecord` is the arbiter's own type: an interface reads the document the Gateway sent, and linking the
 *  component that produced the row would couple a terminal to the runtime instead of to the route. Only the fields this
 *  file renders are named, so a field the Gateway adds cannot break a command that does not read it. */
interface ApprovalRow {
  readonly id: string;
  readonly state: string;
  readonly requestedAt: number;
  readonly answeredBy?: string;
  readonly supersedes?: string;
  readonly request: {
    readonly taskId: string;
    readonly tool: string;
    readonly tier: string;
    readonly summary: string;
    readonly exact: string;
    readonly effects: string;
    readonly reversibility: string;
    readonly whatCouldGoWrong: string;
    readonly expiresAt: number;
    readonly binding: string;
  };
}

interface ApprovalPage {
  readonly items: ApprovalRow[];
  readonly count: number;
  readonly state: string;
  readonly serverTime: string;
}

export async function runApproval(
  verb: ApprovalVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("approval", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }
  // Answered before the Gateway is asked about, for the reason `task cancel` established: a missing id is a usage
  // question and §7.1 gives it exit 2 whether or not a Gateway is running. Answering it after `connect` would make the
  // same typo exit 1 on a machine whose Gateway is down, and a user would then go looking for a Gateway instead of for
  // the id they forgot.
  const decisionId = verb === "approve" || verb === "deny" ? tail.positionals[0] : undefined;
  if ((verb === "approve" || verb === "deny") && decisionId === undefined) {
    renderer.line(`approval ${verb}`, "which approval? `crabby approval ls` prints the ids");
    return EXIT.usage;
  }
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);

  if (verb === "ls") {
    try {
      // `--state` is passed through as text rather than checked against the five states here. The client's own contract
      // says why: a typo must be refused by the Gateway, which answers with a validation error naming all five, rather
      // than coerced locally into a filter that silently matched nothing — an empty queue is exactly what a waiting
      // prompt must never look like. A second copy of the vocabulary in this file would be a second policy, and the two
      // would drift.
      const response = await connection.client.approvals(
        tail.values.state === undefined ? {} : { state: tail.values.state },
      );
      const page = response.body as ApprovalPage;
      if (page.count === 0) {
        renderer.line("approvals", "none waiting");
        renderer.fix(
          `a prompt arrives as an \`approval.requested\` event — \`crabby task watch <id>\` follows one, and ` +
            `--state ${APPROVAL_STATES.filter((name) => name !== "pending").join("|")} reads rows already answered`,
        );
        return renderer.done({ ...page });
      }
      const serverTime = Date.parse(page.serverTime);
      for (const row of page.items) {
        renderer.line(
          shortId(row.id),
          `${row.request.tier} · ${row.request.tool} · ${remaining(row.request.expiresAt, serverTime)}`,
        );
        // The exact target gets its own line rather than sharing one with the countdown. §6.3 asks for exactly one of
        // command, path or destination host in that field, and a user deciding whether to authorise `rm -rf target` has
        // to be looking at `rm -rf target` — a summary is written to describe the action, which is not the same thing as
        // being the action, and approving what a summary says is how a binding comes to cover something nobody meant.
        renderer.line("", clip(row.request.exact, 56));
        renderer.line("", clip(row.request.summary, 56));
      }
      return renderer.done({ ...page });
    } catch (error) {
      return reportFailure(renderer, error);
    }
  }

  if ((verb === "approve" || verb === "deny") && decisionId !== undefined) {
    try {
      const response = await connection.client.decideApproval(decisionId, { decision: verb });
      const body = response.body as { record: ApprovalRow; approvalId: string };
      const record = body.record;
      renderer.line("state", record.state);
      renderer.line("decided", `${record.request.tier} · ${record.request.tool}`);
      renderer.line("", clip(record.request.exact, 56));
      if (verb === "approve") {
        // Printed because the alternative is a user believing they granted something durable. §6.3's binding is what
        // makes an approval safe to give at all: it applies to that action, with those arguments, in that task, and D-057
        // is the decision that says standing authority is the thing this design refuses to accumulate.
        renderer.fix(
          "applies to that action with those arguments in that task, once (§6.3) — this is not standing authority, and " +
            "the same step asked again will ask again",
        );
      }
      return renderer.done({ ...record });
    } catch (error) {
      // No special-casing, and that is the point: `reportFailure` prints the arbiter's own sentence and maps its class
      // to an exit code, so a T3 refused to a terminal (D-085 confines a T3 signature to the TUI and the Web UI) arrives
      // as the arbiter's reason with exit 1, an expired row as its own conflict, and a malformed request as exit 2. A
      // command that rephrased a refusal would be a second voice telling a user why they were denied, and one that
      // swallowed it would leave a prompt looking pending after the Gateway had already settled it.
      return reportFailure(renderer, error);
    }
  }

  renderer.line("approval", "which verb? `ls`, `approve` or `deny`");
  return EXIT.usage;
}

/** §6.3's countdown, measured on the Gateway's clock rather than the terminal's. `serverTime` rides along in the
 *  response for exactly this reason: a phone whose clock runs a minute fast would otherwise render a live prompt as an
 *  expired one, and the Gateway is the party that decides expiry — so the difference is taken against the clock that will
 *  act on it. `expired` is printed rather than a negative number even though the route sweeps before it reads, because a
 *  row that is somehow past its deadline should say so instead of counting upwards from zero. */
function remaining(expiresAt: number, serverTime: number): string {
  const ms = expiresAt - serverTime;
  if (Number.isNaN(ms) || ms <= 0) return "expired";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}
