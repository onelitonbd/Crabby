// `apps/tui/main.ts` — the process: terminal in raw mode, a frame drawn from whatever the panes say, keys bound to actions.
//
// **T1-08's two binds are the reason this file exists at all.** `Ctrl-C` cancels the running task and **does not quit**, and
// quitting while a task runs confirms first. Both are refused by refusing to be the terminal's default: raw mode is on
// (`exitOnCtrlC` is off in P-010's measured finding, and Node's raw mode does the same thing for `readline`), so the bytes
// arrive here and the app decides. An app that quits on Ctrl-C would take a running task with it and D-093's recovery would
// have to rebuild it from a checkpoint the user did not know they were using.
//
// **T1-09's rule is the startup shape**: one line saying what is happening, then the frame — never a blank terminal and
// never a fake progress bar. So the first thing drawn is `connecting to the gateway…` with the exact command if it is not
// running, and the first frame replaces it.
//
// The event loop is the smallest thing that can hold the three obligations at once: keys, a poll for the pane's data, and a
// **capped** repaint (P-011's 4 fps). The repaint cap lives in `FrameRenderer`, not here, because the pane that streams
// fastest is the pane that would forget it.

import os from "node:os";
import { estimateTokens } from "@crabby/agent-runtime";
import {
  type Event,
  EXIT,
  type ExitCode,
  type JobRow,
  type JobRunRecord,
  type SessionContextBody,
  type SessionRow,
  type TaskCheckpoint,
  type TaskRecord,
} from "@crabby/api-contracts";
import { loadConfig, writeConfig } from "@crabby/core";
import { GatewayFailure, readCredentials } from "@crabby/gateway";
import { dataLayout, terminalFacts } from "@crabby/platform";
import { checkPath } from "@crabby/policy";
import { SUPPORTED_FEATURES } from "@crabby/providers";
import { findUnsafeShapes, writeDiagnosticsArtifact } from "../cli/commands/diagnostics.ts";
import { nextOverride, writeOverrideRecord } from "../cli/commands/model-edit.ts";
import { connect } from "../cli/connect.ts";
import { accessLines, type ClientRow, mintLines } from "./access.ts";
import { PROMPT } from "./chatview.ts";
import {
  actionFor,
  applyAction,
  type ComposerState,
  composerView,
  emptyComposer,
  modelSwitchWarning,
  overflowLines,
  SLASH_COMMANDS,
} from "./composer.ts";
import { contextLines } from "./context.ts";
import {
  FRAME_CHROME_ROWS as CHROME,
  frameLines,
  nextPane,
  PANE_ORDER,
  type Pane,
} from "./frame.ts";
import { decodeKey, dumbTerminalNotice, type Key, unknownKeyLine } from "./input.ts";
import type { PaneDescriptor } from "./panes.ts";
import {
  type ApprovalSummary,
  approvalsModal,
  approvalsPane,
  backlogPromptLines,
  chatKey,
  chatPane,
  cycleChoice,
  deleteGapLine,
  deletePromptLines,
  diagnosticsLine,
  EMPTY_TASK_FILTER,
  editFormLines,
  filterTasks,
  formAnswers,
  formLines,
  type JobDeleteConfirm,
  type JobEditForm,
  jobDetailPane,
  jobsPane,
  type LogsView,
  logsPane,
  type ModelEditForm,
  type ModelView,
  modelsPane,
  modelViewsFrom,
  nextLogsView,
  openDeleteConfirm,
  openEditForm,
  openModelForm,
  overrideFieldCount,
  PANE_DESCRIPTORS,
  type PaneContext,
  paneState,
  plannedPane,
  readApprovalItems,
  readJobDetail,
  readJobItems,
  readTaskId,
  readTaskItems,
  resetNoticeLine,
  statusFrom,
  type TaskFilter,
  type TaskReader,
  type TaskSummary,
  tasksPane,
  unparsableFields,
} from "./panes.ts";
import { clip, FrameRenderer, type Terminal } from "./render.ts";
import { switcherLines, switchNote } from "./sessions.ts";
import {
  applyEdit,
  type ConfigEntry,
  configEntries,
  diffLines,
  parseValue as parseValueForDiff,
  settingsLines,
} from "./settings.ts";
import { followEvents, type StreamHandle } from "./stream.ts";
import {
  emptyTaskDetail,
  readEventItems,
  type TaskDetailState,
  taskDetailLines,
} from "./task-detail.ts";
import { type ToolRow, toolsLines } from "./tools.ts";
import {
  addNote,
  addSystem,
  applyEvent,
  commitStreaming,
  emptyTranscript,
  type TranscriptState,
} from "./transcript.ts";

export interface TuiOptions {
  readonly dataDir: string;
  readonly columns: number;
  readonly rows: number;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  /** Injected so a test can drive the loop without a pty; production passes `() => Date.now()`. */
  readonly now?: () => number;
  /** Injected so a test can end the loop; production leaves it unset and `q` ends it. */
  readonly quitAfterKeys?: number;
  /** T1-08's Ctrl-Z, injected like the clock: the default stops the process the honest way (cooked mode, SIGTSTP), and
   *  a test injects a spy so a suspended test runner is not part of the suite. */
  readonly suspend?: (() => void) | undefined;
  /** Injected so the app itself can be tested without a Gateway — the same reason `openai.ts` takes a `fetch`. **The
   *  fake is a whole `TaskReader`, not a patch of one method**, because a test that stubs only the call it exercises
   *  cannot see the pane crash on the call it does not. This seam is what found the two bugs a pty could not reach here:
   *  `listTasks` answering an envelope rather than a bare list, and the start pane making Tab the wrong key for the pane a
   *  person wants. */
  readonly client?: TaskReader | undefined;
}

/** The poll interval for a pane's data. Long enough that a phone is not woken for nothing, short enough that the status
 *  line's "last confirmed" is not a lie: P-011 measured ~300 repaints/s for 200 paced keystrokes, and a poll that repaints
 *  on every tick would spend that budget on data nobody asked for. Two seconds is also the interval T2-02's word can be
 *  stale by, which is the honest bound on how fresh `live` is. */
const POLL_MS = 2000;

export async function runTui(options: TuiOptions): Promise<ExitCode> {
  const { env, stdin, stdout } = options;
  // T1-05: the size is a **live measurement**, not a startup constant — on a phone the soft keyboard opening is the
  // terminal shrinking, and a frame drawn for the old size smears across the new one. `columns` and `rows` are `let`
  // and the terminal object reads them through getters, so a resize is an assignment plus a repaint, and every pane,
  // the frame and the renderer all see the same fresh numbers because they all read the same two bindings.
  let columns = options.columns;
  let rows = options.rows;
  // `terminalFacts` takes the size and the TTY flag from the *caller* rather than reading `process.stdout`, because a test
  // drives this app with a fake stream and a real `process.stdout` would report the phone's width to a 40-column frame.
  const facts = terminalFacts(env, { columns, rows }, stdin.isTTY === true);
  const terminal: Terminal = {
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    write: (text) => stdout.write(text),
  };
  const renderer = new FrameRenderer(terminal);
  const now = options.now ?? (() => Date.now());
  const layout = dataLayout(options.dataDir);
  // `connect` is the CLI's, used as-is: the pairing is a credential on disk and a port in a file, and a second reader of
  // either would be a second opinion about whether a Gateway exists (C7-12's "a local CLI invocation is the owner
  // identity" — the TUI is a local invocation too).
  const connection = await connect(layout);
  // The client is narrowed to what the TUI actually asks of it, rather than exposed whole: the panes depend on a reader with
  // three methods, and a fourth one arriving later is then a decision somebody makes in a pane instead of by accident.
  const client: TaskReader | undefined =
    options.client ??
    (connection.state === "paired" ? (connection.client as unknown as TaskReader) : undefined);

  // **The TUI opens on chat**, not on tasks. §4's pane list starts with chat and `docs/review/TUI.md`'s switch row is
  // `chat · tasks · jobs · approvals · logs · models`; the tasks pane is the *second* thing a person looks at. Opening on
  // tasks also made Tab the wrong key for reaching the pane you wanted — Tab cycles forward, so from tasks it goes to jobs,
  // which is a fact a run on this device showed and no unit test could.
  let pane: Pane = "chat";
  let help = false;
  let tasks: readonly TaskSummary[] = [];
  /** T6's selection. The hint strip has said `j/k move` since the frame slice; the index it moves is wired now that
   *  Enter has somewhere to go (T7's detail). */
  let taskIndex = 0;
  /** T6-01's filter, and whether its edit mode is open: `f` enters and toggles the field, typing narrows live. */
  let taskFilter: TaskFilter = EMPTY_TASK_FILTER;
  let taskFilterEditing = false;
  let approvals: readonly ApprovalSummary[] = [];
  let jobs: readonly JobRow[] = [];
  /** The jobs pane's modes (T17): the detail T17-04 draws, T17-07's backlog prompt — whose `each` answer D-133 moved
   *  onto the wire, retiring this file's walk — T17-06's edit form and T17-05's typed delete confirm. One is open at a
   *  time and each takes the keyboard while it is — the same focus rule T1-07 writes for the approvals modal. */
  let jobIndex = 0;
  let jobDetail: readonly string[] | undefined;
  let jobMissed: readonly JobRunRecord[] = [];
  let jobBacklog = false;
  let jobEdit: JobEditForm | undefined;
  let jobDelete: JobDeleteConfirm | undefined;
  /** The models pane's read half (T11-01/02): `loadConfig`'s document composed by the same functions `crabby model list`
   *  uses, so the pane and the CLI cannot answer differently about an effective descriptor (D-125). */
  let modelViews: readonly ModelView[] = [];
  let modelIndex = 0;
  /** T11-03/04/08's editor and T11-06's reset confirmation. Both take the keyboard while they are open (T1-07's rule,
   *  applied to a form the way it is applied to a modal). */
  let modelEdit: ModelEditForm | undefined;
  let modelResetPending = false;
  /** T7's detail: open over one task, fed by three reads, live-tailed while visible (T7-13 — on when the pane shows,
   *  off otherwise, because battery is a real constraint on a phone). */
  let taskDetail: TaskDetailState | undefined;
  let taskDetailScroll = 0;
  /** T16's switcher overlay. The rows are the Gateway's own (`SessionRow`), the selection is overlay-local, and the
   *  rename/delete flows hold their words here rather than in a second dialog — the overlay is the dialog. */
  let sessionOverlay = false;
  let sessionRows: readonly SessionRow[] = [];
  let sessionIndex = 0;
  let sessionDeleteNote: string | undefined;
  let renameFor: string | undefined;
  let renameBuffer = "";
  /** T8's context view over the current conversation, with the force-compact confirm and the pin input it owns. */
  let contextOpen = false;
  let contextBody: SessionContextBody | undefined;
  let contextConfirm = false;
  let pinTyping = false;
  let pinBuffer = "";
  /** T12's tools view, inside the models pane on `t` (the review groups "Providers/models/tools"; T1-02's row has no
   *  seventh seat). The rows are `GET /tools`'s answer; expansion is per selection. */
  let toolsOpen = false;
  let toolRows: readonly ToolRow[] = [];
  let toolDigest: string | undefined;
  let toolIndex = 0;
  let toolExpanded = false;
  /** T14's access view and T13's config view — two more stops on the logs pane's `v` cycle. The clients state is the
   *  Gateway's answer; the config state is the local file's, walked out of the schema. */
  let clientRows: readonly ClientRow[] = [];
  let clientIndex = 0;
  let revokeConfirmFor: string | undefined;
  let mintNote: readonly string[] | undefined;
  let listener: { readonly host: string; readonly port: number | undefined } | undefined;
  let configRows: readonly ConfigEntry[] = [];
  let configIndex = 0;
  let configEditing: string | undefined;
  let configBuffer = "";
  let configDiff: readonly string[] | undefined;
  /** T5-05's one-turn override and T5-04's attached paths. Both die with the send — a one-turn switch that outlived its
   *  turn would be a permanent switch told as a temporary one, and an attachment that rode every later message would
   *  leak a path into conversations that never asked for it. */
  let draftModel: string | undefined;
  let draftAttachments: readonly string[] = [];
  /** T5-08's queue: messages sent while a task runs wait here instead of interrupting, and `q` lists them. */
  let queue: readonly { readonly objective: string; readonly model?: string | undefined }[] = [];
  let queueOpen = false;
  let queueIndex = 0;
  /** T15's three views. `decisions` is T15-04's data — every state of `GET /approvals`, because the view's subject is
   *  every prompt *and its answer*, `expired` included. */
  let logsView: LogsView = "log";
  let decisions: readonly ApprovalSummary[] = [];
  let approvalOpen = false;
  let approvalIndex = 0;
  let approvalConflict = false;
  let message: string | undefined;
  let quit = false;
  // The chat pane's two states. Both are plain data and both are drawn from, which is what lets the whole pane be tested
  // without a stream (and what would let a reconnect rebuild them from `GET /tasks/{id}` rather than from a replay).
  let transcript: TranscriptState = emptyTranscript(
    columns,
    facts.color === "none" ? "none" : facts.color,
  );
  let composer: ComposerState = emptyComposer();
  /** The stream handle, kept for its lifetime. Nothing consults it — closing it *is* the shutdown, so the shutdown closes it
   *  rather than the loop asking whether it is still there. */
  let stream: StreamHandle | undefined;
  /** T5-09's input history, per session. Held here rather than in the composer because the composer is handed one entry at a
   *  time — a buffer that owns its own history would have to survive the pane switch, and a TUI that keeps two copies of what
   *  a person typed is a TUI with two answers to "what did I send". */
  const previousInputs: string[] = [];
  /** T1-08's one confirmation: a quit gesture (q, Ctrl-Q) with a task running arms this and says in words what happens
   *  to the task; the same gesture again quits. Every other key disarms it — an armed quit that survives an unrelated
   *  key is a trap, and "confirms once" means one press, not an armed state that lingers. */
  let quitArmed = false;
  /** T5-02: where the real cursor belongs in the *pane body*, set by `body()`'s chat branch and consumed by the draw
   *  pair. `undefined` means "not the composer" — every other pane keeps the cursor hidden, because a cursor parked in
   *  a list is a lie about where typing would land. */
  let cursorHint: { readonly row: number; readonly column: number } | undefined;
  /** The pane-body row count of the frame being drawn — the input to the padding/slice arithmetic `placeCursorHint`
   *  redoes. Set by the draw pair right after `body()` returns, because the message line is pushed *after* the body and
   *  must not count as body rows. */
  let bodyRowCount = 0;

  // T1-09: the first line is never blank, and when the Gateway is not running it names the command rather than showing a
  // spinner that pretends something is happening.
  // T1-09's first line, and it is about the Gateway rather than the keyboard. An earlier version folded T3-05's dumb
  // terminal notice in here too, so a connected-less TUI printed "keys are not reported" beside "no paired gateway" — two
  // unrelated facts in one screen, one of which was wrong.
  const first =
    client === undefined
      ? [`no paired gateway (${connection.state}) — start one with: crabby gateway start`, ""]
      : ["connecting to the gateway…", ""];
  stdout.write(`${first.join("\n")}\n`);

  const readTasks = async (): Promise<void> => {
    if (client === undefined) return;
    try {
      tasks = readTaskItems((await client.listTasks({ limit: 20 })).body);
      if (taskIndex >= tasks.length) taskIndex = Math.max(0, tasks.length - 1);
    } catch (error) {
      // T1-10's rule again: the reason in words, never a spinner. A failed poll leaves the last good list on screen with a
      // line saying it is stale, because a stale list labelled stale is more useful than an empty pane.
      message = `task list failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const readApprovals = async (): Promise<void> => {
    if (client?.listApprovals === undefined) return;
    try {
      approvals = readApprovalItems(
        (await client.listApprovals({ state: "pending" })).body,
      ) as readonly ApprovalSummary[];
      if (approvalIndex >= approvals.length) approvalIndex = Math.max(0, approvals.length - 1);
      if (approvals.length === 0) approvalOpen = false;
    } catch (error) {
      message = `approval list failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const readJobs = async (): Promise<void> => {
    if (client?.listJobs === undefined) return;
    try {
      jobs = readJobItems((await client.listJobs()).body);
      if (jobIndex >= jobs.length) jobIndex = Math.max(0, jobs.length - 1);
    } catch (error) {
      message = `job list failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  /** T15-04's data: the queue is per-state (`GET /approvals?state=`), and the view asks for every one of the five —
   *  a decisions list that skipped `expired` would render expiry as silence. */
  const readDecisions = async (): Promise<void> => {
    const listApprovals = client?.listApprovals;
    if (listApprovals === undefined) return;
    try {
      const states = ["pending", "approved", "denied", "expired", "consumed"] as const;
      const pages = await Promise.all(states.map((state) => listApprovals({ state })));
      const rows: ApprovalSummary[] = [];
      for (const page of pages)
        rows.push(...(readApprovalItems(page.body) as readonly ApprovalSummary[]));
      rows.sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
      decisions = rows;
    } catch (error) {
      message = `approval decisions failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  /** T7's three reads, into one state. The checkpoint read may answer 404 *with* D-065's verdict in `details` — that
   *  is an answer ("no saved state"), not a failure, and it becomes the panel's note rather than an error line. */
  const readTaskDetail = async (id: string): Promise<void> => {
    if (client?.getTask === undefined) return;
    try {
      const record = (await client.getTask(id)).body as TaskRecord;
      let checkpoint: TaskCheckpoint | undefined;
      let checkpointNote: string | undefined;
      if (client.taskCheckpoint !== undefined) {
        try {
          checkpoint = (await client.taskCheckpoint(id)).body as TaskCheckpoint;
        } catch (error) {
          // A 404 with D-065's verdict in `details` is an answer — "no saved state" — not a failure of the read; the
          // Gateway says what the absence means (D-092's discipline) and the panel repeats it rather than inventing one.
          if (error instanceof GatewayFailure && error.status === 404) {
            const details = (error.envelope.error.details ?? {}) as {
              readonly verdict?: string;
              readonly reason?: string;
            };
            checkpointNote =
              details.verdict !== undefined
                ? `no boundary (${details.verdict}${details.reason === undefined ? "" : ` — ${details.reason}`})`
                : "no boundary was committed — a resume would start from the beginning of the conversation";
          } else {
            checkpointNote = `checkpoint read failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }
      let events: readonly Event[] = [];
      if (client.taskEvents !== undefined) {
        events = readEventItems((await client.taskEvents(id)).body);
      }
      const pending = approvals
        .filter((approval) => approval.request.taskId === id)
        .map((approval) => ({ id: approval.id, summary: approval.request.summary }));
      const previous = taskDetail;
      taskDetail = {
        ...emptyTaskDetail(record, checkpoint, checkpointNote),
        events,
        approvalsPending: pending,
        tail: previous?.tail ?? true,
      };
    } catch (error) {
      message = `task detail failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const readSessions = async (): Promise<void> => {
    if (client?.sessions === undefined) return;
    try {
      const body = (await client.sessions()).body as { readonly items?: readonly SessionRow[] };
      sessionRows = body.items ?? [];
      if (sessionIndex >= sessionRows.length) sessionIndex = Math.max(0, sessionRows.length - 1);
    } catch (error) {
      message = `sessions read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const readContext = async (): Promise<void> => {
    const id = lastSession(transcript);
    if (id === undefined) {
      message =
        "no conversation to show context of — send one message first, or switch sessions with s";
      return;
    }
    if (client?.sessionContext === undefined) return;
    try {
      contextBody = (await client.sessionContext(id)).body as SessionContextBody;
    } catch (error) {
      contextOpen = false;
      message = `context read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  /** T8-08's numbers, kept fresh without the context view: the same read `c` does, silent on failure — a background
   *  refresh that could not answer must not scold the person for a pane they never opened. */
  const refreshContext = async (): Promise<void> => {
    // The transcript's own session when the frames said so, else the switcher's — and when neither is known yet, one
    // silent list fetch names the conversation a send just opened, because a fresh conversation is exactly the one
    // whose budget a first big draft is about to meet.
    let id = lastSession(transcript);
    if (id === undefined && sessionRows.length === 0 && client?.sessions !== undefined) {
      try {
        const body = (await client.sessions()).body as { readonly items?: readonly SessionRow[] };
        sessionRows = body.items ?? [];
        if (sessionIndex >= sessionRows.length) sessionIndex = Math.max(0, sessionRows.length - 1);
      } catch {
        // A background refresh that cannot list stays silent; the next send tries again.
      }
    }
    id ??= sessionRows[sessionIndex]?.id;
    if (id === undefined || client?.sessionContext === undefined) return;
    try {
      contextBody = (await client.sessionContext(id)).body as SessionContextBody;
    } catch {
      // The numbers stay whatever they were: a stale estimate is a fact, a scolding is not.
    }
  };
  const readTools = async (): Promise<void> => {
    if (client?.tools === undefined) return;
    try {
      const body = (await client.tools()).body as {
        readonly items?: readonly ToolRow[];
        readonly registry?: { readonly digest?: string };
      };
      toolRows = body.items ?? [];
      toolDigest = body.registry?.digest;
      if (toolIndex >= toolRows.length) toolIndex = Math.max(0, toolRows.length - 1);
    } catch (error) {
      message = `tools read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const readClients = async (): Promise<void> => {
    if (client?.authList === undefined) return;
    try {
      const body = (await client.authList()).body as { readonly items?: readonly ClientRow[] };
      clientRows = body.items ?? [];
      if (clientIndex >= clientRows.length) clientIndex = Math.max(0, clientRows.length - 1);
    } catch (error) {
      message = `clients read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const readListener = async (): Promise<void> => {
    if (client?.diagnostics === undefined) return;
    try {
      const body = (await client.diagnostics()).body as {
        readonly listener?: { readonly host: string; readonly port: number | undefined };
      };
      listener = body.listener;
    } catch {
      // The listener line is additive; a failed diagnostics read leaves the view without it rather than in an error.
    }
  };
  const readConfig = (): void => {
    try {
      configRows = configEntries(loadConfig(layout).config);
      if (configIndex >= configRows.length) configIndex = Math.max(0, configRows.length - 1);
    } catch (error) {
      message = `config read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const readModels = (): void => {
    try {
      const config = loadConfig(layout);
      modelViews = modelViewsFrom(
        config.config.provider as Record<string, Record<string, unknown>> | undefined,
      );
      if (modelIndex >= modelViews.length) modelIndex = Math.max(0, modelViews.length - 1);
    } catch (error) {
      message = `config read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  /** Re-read the detail the pane is showing, so an act that changed the job redraws T17-04's rows from the Gateway
   *  rather than from the answer this app happened to hold. */
  const readJobDetailIntoState = async (): Promise<void> => {
    if (client?.job === undefined || jobDetail === undefined) return;
    const job = jobs[jobIndex];
    if (job === undefined) return;
    try {
      const detail = readJobDetail((await client.job(job.id)).body);
      jobMissed = detail.missedUnacknowledged;
      jobDetail = jobDetailPane(detail, columns);
    } catch (error) {
      message = `job detail failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  /** T17-06's save. `schedule` is the non-material half `PATCH /jobs/{id}` carries; `objective` is §4.5's material half
   *  and the row's re-approval notice is what the save prints — a material change cannot ride on the old authorization
   *  and nothing in this build can open a new one (D-084), so an objective change lands as the notice and no write. */
  const saveJobEdit = async (job: JobRow, schedule: string, objective: string): Promise<string> => {
    const scheduleChanged = schedule !== job.schedule;
    const objectiveChanged = objective !== job.objective;
    if (!scheduleChanged && !objectiveChanged) return "nothing changed";
    if (objectiveChanged) {
      return (
        "the objective is what the job *does*, and changing it crosses into re-approval (§4.5) — no route in this " +
        "build can open one (D-084), so nothing was written; the schedule field can still be saved on its own"
      );
    }
    if (client?.patchJob === undefined) return "this Gateway client cannot edit jobs";
    const response = await client.patchJob(job.id, { schedule });
    await readJobs();
    await readJobDetailIntoState();
    void draw();
    return (response.body as { note?: string } | null)?.note ?? "the schedule was written";
  };
  /** T11-03/04/08's save, through the one stored-value path: `nextOverride` (D-064's rules) then `writeOverrideRecord`
   *  (the CAS write `crabby model edit` makes). T11-04's `reserve` is collected and reported as not-stored — F-62
   *  closed `reserveForOutput` as derived, and the record has no column to put it in. */
  const saveModelEdit = async (form: ModelEditForm): Promise<string> => {
    const bad = unparsableFields(form);
    if (bad.length > 0) return `${bad.join(", ")} must be a whole number — nothing was written`;
    const next = nextOverride(form.view.override, formAnswers(form));
    if (!next.ok) return next.reason;
    const loaded = loadConfig(layout);
    const report = writeOverrideRecord(
      layout,
      loaded,
      form.view.provider,
      form.view.model,
      next.override,
    );
    readModels();
    void draw();
    if (!report.ok) return report.message ?? "nothing was written";
    const reserveNote =
      form.reserve.buffer.trim().length === 0
        ? ""
        : " — reserve is derived from the budget rules and is not stored per model (F-62)";
    return report.changes.length === 0
      ? `effective unchanged — every value you set is what the endpoint already reported${reserveNote}`
      : `${report.changes.join("; ")}${reserveNote}`;
  };
  /** The composer's key table, reused for the edit form and the typed confirm: one table for "what does a key mean while
   *  typing", so the form and the composer cannot disagree about where the cursor is. `send` is mapped by the caller. */
  const actionForKey = (key: Key): ReturnType<typeof actionFor> | undefined => {
    const typed =
      key.kind === "char" ||
      key.kind === "enter" ||
      key.kind === "backspace" ||
      key.kind === "left" ||
      key.kind === "right" ||
      key.kind === "up" ||
      key.kind === "down" ||
      key.kind === "ctrl" ||
      key.kind === "unknown";
    return typed ? actionFor(key, false) : undefined;
  };
  const applyComposerAction = (
    state: ComposerState,
    action: ReturnType<typeof actionFor>,
  ): ComposerState => applyAction(state, action, undefined);

  await readTasks();
  await readApprovals();
  await readJobs();
  readModels();

  const context = (): PaneContext => ({
    client: client as TaskReader,
    pane,
    rows,
    columns,
    color: facts.color === "none" ? "none" : facts.color,
    offline: client === undefined,
    ...(connection.state === "paired" ? {} : { lastConfirmed: undefined }),
  });

  /** The pane's own body. The chat pane is the transcript plus the composer (T4/T5); every other pane is whatever it draws
   *  itself. Kept here rather than in `frameLines` so that "which pane am I in" is answered once, and the frame stays a
   *  function of (pane, body) with no knowledge of any pane's content. */
  const body = (): readonly string[] => {
    // Every pane that is not the chat composer leaves the hint unset — the draw pair reads it after the call.
    cursorHint = undefined;
    if (approvalOpen && approvals.length > 0) {
      const currentApproval = approvals[approvalIndex];
      if (currentApproval === undefined) return [];
      return approvalsModal(currentApproval, {
        index: approvalIndex,
        total: approvals.length,
        columns,
        rows: rows - CHROME,
        conflict: approvalConflict,
      });
    }
    if (sessionOverlay) {
      return switcherLines(sessionRows, lastSession(transcript), sessionIndex, columns, {
        now: now(),
        deleteNote: sessionDeleteNote,
        renameFor,
        renameBuffer,
      });
    }
    if (contextOpen && contextBody !== undefined) {
      return contextLines(contextBody, columns, contextConfirm, pinTyping ? pinBuffer : undefined);
    }
    if (queueOpen) {
      // T5-08's list: the queue with its count, the selected row marked, and the reorder/drop keys named. It is the
      // only place `q` means the queue, and the chat hint strip says so while anything waits in it.
      const lines = [`queued while the run works: ${String(queue.length)}`];
      const first = Math.max(0, Math.min(queueIndex - 4, queue.length - 8));
      const shown = queue.slice(first, first + 8);
      for (let index = 0; index < shown.length; index += 1) {
        const item = shown[index] as { readonly objective: string };
        const cursor = first + index === queueIndex ? ">" : " ";
        lines.push(`${cursor} ${clip(item.objective, columns - 2)}`);
      }
      lines.push("Enter send now · j/k move · u up · n down · d drop · Esc back");
      return lines;
    }
    if (pane === "chat") {
      // The draft's own lines (T5-03/04/05/08/10). Each is one line, each says what it is, and none exists when its fact
      // does not: a queue count with no queue would be a lie about traffic that is not happening.
      const extras: string[] = [];
      if (draftModel !== undefined)
        extras.push(`this turn on ${draftModel} (one-turn override, T5-05)`);
      if (draftAttachments.length > 0)
        extras.push(`attached: ${draftAttachments.join(", ")} (T5-04)`);
      if (composer.buffer.trim().length > 0) {
        extras.push(
          `the draft is ~${estimateTokens(composer.buffer).toLocaleString("en-US")} tokens (estimate, not a count — D-064)`,
        );
      }
      if (queue.length > 0 && !queueOpen) {
        extras.push(`queued while the run works: ${String(queue.length)} — q lists them (T5-08)`);
      }
      // T8-08: the warning computes from what the Gateway counted (projected) plus this draft's own estimate, against
      // the window the session's model reported. No numbers, no warning — a guess about a window nobody stated would
      // be exactly the false alarm the row's "before sending, not as an error afterwards" is refusing.
      const windowSize = contextBody?.budget?.window;
      if (windowSize !== undefined) {
        for (const line of overflowLines(
          contextBody?.projected.tokens ?? 0,
          estimateTokens(composer.buffer),
          windowSize,
        )) {
          extras.push(line);
        }
      }
      // T5-02: with a real TTY the block glyph is not drawn and the *terminal's* cursor is placed at the edit point
      // instead — Termux's IME and its editing keys only behave around a real cursor. The row is a body-row computation:
      // the composer's lines sit `extras + capability line` above the body's end, so the edit row is the body length
      // minus that tail plus the view's own cursor line. `--plain` and pipes keep the drawn block (no cursor to move).
      const view = composerView(composer, columns, false);
      // The skin's model fact (T4-02's header source): the draft's one-turn override wins, then the running task's
      // model — the model the turn is actually being spoken with. When neither exists the header stays absent,
      // because a model line that names a guess is worse than no model line.
      const runningModel = tasks.find(
        (task) => task.state === "running" || task.state === "awaiting_approval",
      )?.model;
      const bodyLines = chatPane(
        transcript,
        composer,
        // T5-06's capability line. **These come from what the Gateway composed for this identity**, and until the chat pane
        // reads that route they are the documented defaults — printed as they are, because a wrong "shell: on" is a wrong
        // promise about what a run may do, and the defaults here are the conservative ones. The route that would make
        // them real is the caller's own grants row: GET /auth/clients carries `capabilities` per identity, but nothing
        // answers "which one am I" — a gap this line names in HANDOVER rather than guesses past.
        { fs: "workspace", net: false, shell: false },
        columns,
        rows - CHROME,
        extras,
        facts.isTTY,
        {
          tier: context().color,
          ...(draftModel === undefined && runningModel === undefined
            ? {}
            : { model: draftModel ?? runningModel }),
          ...(lastSession(transcript) === undefined ? {} : { session: lastSession(transcript) }),
        },
      );
      cursorHint = facts.isTTY
        ? {
            row: bodyLines.length - extras.length - 1 - view.lines.length + view.cursorLine,
            // The prompt mark is part of the composer's first drawn line, so the real cursor sits past it —
            // PROMPT's width and the drawing can never disagree, because both come from the one constant.
            column: Math.min(
              view.cursorColumn + (view.cursorLine === 0 ? PROMPT.length : 2),
              columns - 1,
            ),
          }
        : undefined;
      return bodyLines;
    }
    const descriptor = descriptorFor(pane);
    if (pane === "tasks" && taskDetail !== undefined) {
      return taskDetailLines(taskDetail, columns, rows - CHROME);
    }
    if (pane === "approvals") {
      return approvalsPane(context(), approvals);
    }
    if (pane === "jobs") {
      // The modes draw over the list, and each is a projection of state this app holds: the form T17-06 sizes at 4–6
      // lines, the delete confirm T17-05 prices with the typed name, T17-07's prompt, and T17-04's detail. The list is
      // what is underneath all of them.
      if (jobEdit !== undefined) return editFormLines(jobEdit, columns);
      if (jobDelete !== undefined) return deletePromptLines(jobDelete, columns);
      if (jobBacklog) return backlogPromptLines(jobMissed);
      if (jobDetail !== undefined) return jobDetail;
      return jobsPane(context(), jobs, jobIndex);
    }
    if (pane === "logs") {
      if (logsView === "clients") {
        return accessLines(clientRows, columns, clientIndex, {
          listener,
          confirmFor: revokeConfirmFor,
          mint: mintNote,
          ownClientId: readCredentials(layout)?.clientId,
        });
      }
      if (logsView === "config") {
        return settingsLines(configRows, columns, configIndex, {
          editing: configEditing,
          buffer: configBuffer,
          diff: configDiff,
        });
      }
      return logsPane(context(), logsView, decisions);
    }
    if (pane === "models" && toolsOpen) {
      return toolsLines(toolRows, columns, toolIndex, toolExpanded, rows - CHROME, toolDigest);
    }
    if (pane === "models") {
      if (modelEdit !== undefined) return formLines(modelEdit, columns);
      const body = [...modelsPane(context(), modelViews, modelIndex)];
      if (modelResetPending) {
        const current = modelViews[modelIndex] ?? modelViews[0];
        if (current !== undefined) {
          body.push(`! ${resetNoticeLine(overrideFieldCount(current))}`);
        }
      }
      return body;
    }
    return descriptor.built === true
      ? tasksPane(context(), tasks, taskIndex, { ...taskFilter, active: taskFilterEditing })
      : plannedPane(
          pane,
          descriptor.milestone ?? "M3",
          descriptor.equivalent ?? "crabby diagnostics",
        );
  };

  /** The frame's descriptor, with the one state-dependent hint swap the app makes: while messages sit queued, the chat
   *  pane's `q` lists them instead of quitting (T5-08), and the hint strip is the authority (T3-04) — so the strip says
   *  `q queue` for exactly as long as that is the truth. */
  const frameDescriptor = () => {
    const descriptor = descriptorFor(pane);
    if (pane !== "chat" || queue.length === 0) return descriptor;
    return {
      ...descriptor,
      // The swap never removes the way out: `q` now lists the queue, so the same hint names the quit that remains —
      // Ctrl-C's second press — rather than leaving the strip silent about leaving (T3-01's protection).
      hints: descriptor.hints.map((hint) => (hint === "q quit" ? "q queue · Ctrl-C quit" : hint)),
    };
  };

  const draw = (): void => {
    const lines0 = [...body()];
    bodyRowCount = lines0.length;
    if (message !== undefined) lines0.push(`! ${message}`);
    const lines = frameLines(
      paneState(context(), frameDescriptor(), lines0, statusFrom(context(), tasks, jobs), help),
      columns,
      rows,
    );
    renderer.draw(lines, now());
    placeCursorHint();
  };

  /** The uncapped repaint, for **key-driven** frames. P-011's cap exists so a streaming answer cannot repaint the world
   *  at token speed; a keypress is already at human speed, and a key that draws nothing until the next poll is a phone
   *  that feels dead. The frozen-clock tests are what found this: a cap driven by an injected `now` swallowed every
   *  frame after the first, which is the cap protecting the user into the opposite failure. */
  const drawNow = (): void => {
    const lines0 = [...body()];
    bodyRowCount = lines0.length;
    if (message !== undefined) lines0.push(`! ${message}`);
    const lines = frameLines(
      paneState(context(), frameDescriptor(), lines0, statusFrom(context(), tasks, jobs), help),
      columns,
      rows,
    );
    renderer.drawNow(lines);
    placeCursorHint();
  };

  /** T5-02's last step: the hint `body()` left is a *body* row — the frame adds the pane row above it and pads or
   *  slices the body to `rows - CHROME`, so the frame row is that arithmetic, and the renderer moves the real cursor
   *  there and shows it. No hint means the cursor hides: a cursor parked on a list is a lie about where typing lands. */
  const placeCursorHint = (): void => {
    if (cursorHint === undefined) {
      renderer.hideCursor();
      return;
    }
    const bodyHeight = Math.max(1, rows - CHROME);
    const overflow = Math.max(0, bodyRowCount - bodyHeight);
    const pad = Math.max(0, bodyHeight - bodyRowCount);
    renderer.placeCursor(1 + pad + cursorHint.row - overflow, cursorHint.column);
  };

  // The stream, opened once and kept. **It is not opened per pane switch**: a socket per switch is a socket per keypress,
  // and the Gateway's connection count is not the place a TUI should be discovering its bounds. The pane that draws it
  // changes; the stream does not.
  const pairedUrl =
    options.client === undefined && connection.state === "paired" ? connection.url : undefined;
  if (client !== undefined && pairedUrl !== undefined) {
    stream = followEvents({
      url: pairedUrl,
      layout,
      onFrame: (frame) => {
        transcript = applyEvent(commitStreaming(transcript), frame);
        draw();
      },
      onClosed: (reason) => {
        // T1-10's rule and T4-13's: the reason in words, and the transcript keeps what it had rather than emptying itself —
        // a conversation that vanishes when a socket hiccups is worse than one that is visibly stale.
        message = `stream: ${reason}`;
        draw();
      },
    });
  }

  if (facts.isTTY === false) {
    // T3-05: a terminal that cannot report keys gets the list once and then a stream of frames it cannot act on — so it gets
    // the list, the frames, and nothing pretending to be interactive.
    stdout.write(
      `${dumbTerminalNotice(PANE_ORDER, ["Tab panes", "? help", "q quit"]).join("\n")}\n`,
    );
  }

  let seen = 0;
  stdin.setRawMode?.(true);
  renderer.hideCursor();
  stdin.resume();
  // T1-08's other half of Ctrl-Z: the shell's `fg` delivers SIGCONT, and the app must put itself back the way the
  // suspend found it — raw mode on, the frame redrawn — rather than leaving a cooked terminal drawing raw bytes.
  process.on("SIGCONT", () => {
    stdin.setRawMode?.(true);
    drawNow();
  });

  // **The `end` promise is created before the first frame**, and that is a product rule rather than a test convenience.
  // Android freezes and kills this process whenever it feels like it, a pipe runs out, and a terminal window can close —
  // so a stdin that ends before the app finished drawing must *end the app*, not be missed by a listener that had not been
  // attached yet. The first version attached both listeners after the first draw, which meant a stream that ended early
  // left the app waiting forever: a hang on the exact platform whose process death the whole of `AGENTS.md` §8 is about.
  let stop = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    stop = resolve;
  });
  stdin.once("end", () => stop());

  const onData = (chunk: Buffer | string): void => {
    let buffer = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const decoded = decodeKey(buffer);
      if (decoded === undefined) return; // A partial escape sequence: wait for the rest.
      buffer = decoded.rest;
      seen += 1;
      const wasEnter = decoded.key.kind === "enter";
      if (handle(decoded.key)) return;
      // A keyboard that sends Enter as CRLF delivers `\r\n` — one press, two bytes — and the `\n` would land as a
      // Ctrl+J newline in the composer the send just emptied, which reads on screen as a composer that typed itself a
      // blank first line. One Enter per CRLF: after an `enter`, a single immediately-following LF is the same press's
      // tail, not a second key.
      if (wasEnter && buffer.startsWith("\n")) buffer = buffer.slice(1);
      if (options.quitAfterKeys !== undefined && seen >= options.quitAfterKeys) {
        quit = true;
        return;
      }
      // The key echo is uncapped (drawNow): P-011 throttles streaming repaints, not a person's keystrokes — and with the
      // tests' frozen clock a capped path here swallowed every frame after the first, which is how the Tab and typing
      // tests exposed it.
      drawNow();
    }
  };

  const handle = (key: Key): boolean => {
    // Any key other than the quit gestures re-arms from scratch: the handlers below read `wasArmed` and set the flag
    // when they ask. Resetting *before* the handlers is the difference between "confirms once" and a trap — but the two
    // quit handlers must see the value the *previous* key left, so it is captured, not zeroed for them.
    const wasArmed = quitArmed;
    quitArmed = false;
    if (approvalOpen && approvals.length > 0) {
      if (key.kind === "char" && key.char === "a") {
        void (async () => {
          if (client?.decideApproval === undefined) return;
          const current = approvals[approvalIndex];
          if (current === undefined) return;
          try {
            await client.decideApproval(current.id, { decision: "approve", scope: "once" });
            approvals = approvals.filter((item) => item.id !== current.id);
            if (approvalIndex >= approvals.length)
              approvalIndex = Math.max(0, approvals.length - 1);
            approvalConflict = false;
            if (approvals.length === 0) approvalOpen = false;
            message = `approval ${current.id} approved`;
          } catch (error) {
            approvalConflict = true;
            message = error instanceof Error ? error.message : String(error);
          }
          draw();
        })();
        return false;
      }
      if (key.kind === "char" && key.char === "d") {
        void (async () => {
          if (client?.decideApproval === undefined) return;
          const current = approvals[approvalIndex];
          if (current === undefined) return;
          try {
            await client.decideApproval(current.id, { decision: "deny", scope: "once" });
            approvals = approvals.filter((item) => item.id !== current.id);
            if (approvalIndex >= approvals.length)
              approvalIndex = Math.max(0, approvals.length - 1);
            approvalConflict = false;
            if (approvals.length === 0) approvalOpen = false;
            message = `approval ${current.id} denied`;
          } catch (error) {
            approvalConflict = true;
            message = error instanceof Error ? error.message : String(error);
          }
          draw();
        })();
        return false;
      }
      if (key.kind === "char" && key.char === "n") {
        if (approvals.length > 0) approvalIndex = (approvalIndex + 1) % approvals.length;
        return false;
      }
      if (key.kind === "char" && key.char === "p") {
        if (approvals.length > 0)
          approvalIndex = (approvalIndex - 1 + approvals.length) % approvals.length;
        return false;
      }
      if (key.kind === "escape") {
        return false;
      }
      if (key.kind === "char" && key.char === "?") {
        message = "rule and tier shown in the card above";
        return false;
      }
      return false;
    }
    // T16's switcher keys. The overlay owns its letters (T16-04 names them), `d` says the T3 gap rather than faking a
    // confirm, and `t`'s rename is typed inline with the row's own revision as the If-Match (T16-05's one write path).
    if (sessionOverlay) {
      if (key.kind === "escape") {
        sessionOverlay = false;
        sessionDeleteNote = undefined;
        renameFor = undefined;
        return false;
      }
      if (renameFor !== undefined) {
        if (key.kind === "char") {
          renameBuffer = renameBuffer + key.char;
          return false;
        }
        if (key.kind === "backspace") {
          renameBuffer = renameBuffer.slice(0, -1);
          return false;
        }
        if (key.kind === "enter") {
          const row = sessionRows[sessionIndex];
          const title = renameBuffer.trim();
          if (client?.patchSession === undefined || row === undefined) return false;
          if (title.length === 0) {
            renameFor = undefined;
            return false;
          }
          void client
            .patchSession(renameFor, { title }, row.revision)
            .then(() => readSessions().then(drawNow))
            .then(() => {
              renameFor = undefined;
              renameBuffer = "";
              message = "renamed — the status line reads the same row, so it cannot disagree";
            })
            .catch((error: unknown) => {
              renameFor = undefined;
              renameBuffer = "";
              message = `rename refused: ${error instanceof Error ? error.message : String(error)}`;
              draw();
            });
          return false;
        }
        return false;
      }
      if (
        key.kind === "up" ||
        key.kind === "down" ||
        (key.kind === "char" && (key.char === "j" || key.char === "k"))
      ) {
        const down = key.kind === "down" || (key.kind === "char" && key.char === "j");
        sessionIndex = down
          ? Math.min(sessionRows.length - 1, sessionIndex + 1)
          : Math.max(0, sessionIndex - 1);
        return false;
      }
      if (key.kind === "char" && key.char === "n") {
        if (client?.createSession === undefined) return false;
        void client
          .createSession({})
          .then(() => readSessions().then(drawNow))
          .catch((error: unknown) => {
            message = `create refused: ${error instanceof Error ? error.message : String(error)}`;
            draw();
          });
        return false;
      }
      if (key.kind === "char" && key.char === "t") {
        const row = sessionRows[sessionIndex];
        if (row !== undefined) {
          renameFor = row.id;
          renameBuffer = "";
        }
        return false;
      }
      if (key.kind === "char" && key.char === "d") {
        // No `DELETE /sessions/{id}` exists in this build, and that is a decision the Gateway records (T3 keeps the one
        // confirmed path). The overlay says so instead of drawing a confirmation a route could not honour.
        sessionDeleteNote =
          "deleting waits for `crabby history delete` (T3's one confirmed path) — this overlay will not fake a confirm";
        return false;
      }
      if (key.kind === "enter") {
        const row = sessionRows[sessionIndex];
        if (row === undefined) return false;
        sessionOverlay = false;
        sessionDeleteNote = undefined;
        // T16-07: switching re-points the composer; the work in motion is told about, in words.
        transcript = addSystem(
          transcript,
          row.id === lastSession(transcript) ? `already in ${row.titleShown}` : `session ${row.id}`,
        );
        const note = switchNote(row);
        if (note !== undefined) transcript = addSystem(transcript, note);
        void readTasks().then(drawNow);
        return false;
      }
      return false;
    }
    // T8's context view. `c` confirms itself (the sections on screen are the preview T8-07 asks for), `p` takes a
    // typed turn range, and Esc leaves.
    if (contextOpen) {
      if (key.kind === "escape") {
        contextOpen = false;
        contextConfirm = false;
        pinTyping = false;
        pinBuffer = "";
        return false;
      }
      if (pinTyping) {
        if (key.kind === "char") {
          pinBuffer = pinBuffer + key.char;
          return false;
        }
        if (key.kind === "backspace") {
          pinBuffer = pinBuffer.slice(0, -1);
          return false;
        }
        if (key.kind === "enter") {
          const id = lastSession(transcript);
          const match = /^(\d+)-(\d+)$/.exec(pinBuffer.trim());
          pinTyping = false;
          pinBuffer = "";
          if (client?.pinMessages === undefined || id === undefined || match === null) return false;
          const from = Number(match[1]);
          const through = Number(match[2]);
          if (from < 1 || through < from) {
            message = "a pin range is `from-through`, like 3-5";
            return false;
          }
          void client
            .pinMessages(id, { from, through })
            .then(() => readContext().then(drawNow))
            .catch((error: unknown) => {
              message = `pin refused: ${error instanceof Error ? error.message : String(error)}`;
              draw();
            });
          return false;
        }
        return false;
      }
      if (key.kind === "char" && key.char === "p") {
        pinTyping = true;
        pinBuffer = "";
        return false;
      }
      if (key.kind === "char" && key.char === "c") {
        if (client?.compactSession === undefined) return false;
        if (!contextConfirm) {
          contextConfirm = true;
          return false;
        }
        contextConfirm = false;
        const id = lastSession(transcript);
        if (id === undefined) return false;
        void client
          .compactSession(id)
          .then((response) => {
            const note = (response.body as { readonly note?: string }).note;
            message = note ?? "compaction asked for";
            return readContext().then(drawNow);
          })
          .catch((error: unknown) => {
            message = `compact refused: ${error instanceof Error ? error.message : String(error)}`;
            draw();
          });
        return false;
      }
      return false;
    }
    // T6-01's filter edit mode. It sits **here** — before the globals — because an edit mode is T1-07's modal in a
    // row's clothing: while it is open the letters are text (`s` a session id contains, `a` a state prefix may), and
    // the globals get the keys back the moment Enter closes it or Esc clears it.
    if (taskFilterEditing && pane === "tasks" && taskDetail === undefined) {
      if (key.kind === "escape") {
        taskFilter = { ...taskFilter, state: "", session: "" };
        taskFilterEditing = false;
        message = "filter cleared";
        return false;
      }
      if (key.kind === "enter") {
        taskFilterEditing = false;
        return false;
      }
      if (key.kind === "char" && key.char === "f") {
        taskFilter = { ...taskFilter, field: taskFilter.field === "state" ? "session" : "state" };
        return false;
      }
      if (key.kind === "char") {
        const value =
          (taskFilter.field === "state" ? taskFilter.state : taskFilter.session) + key.char;
        taskFilter =
          taskFilter.field === "state"
            ? { ...taskFilter, state: value }
            : { ...taskFilter, session: value };
        return false;
      }
      if (key.kind === "backspace") {
        const value = (taskFilter.field === "state" ? taskFilter.state : taskFilter.session).slice(
          0,
          -1,
        );
        taskFilter =
          taskFilter.field === "state"
            ? { ...taskFilter, state: value }
            : { ...taskFilter, session: value };
        return false;
      }
      return false;
    }
    // T16-01: `s` opens the switcher from any pane — except chat, where T3-04 gives every printable key to the
    // composer and `s` stays a literal. From tasks, jobs, approvals, logs or models, it is the switcher's key.
    if (key.kind === "char" && key.char === "s" && !help && pane !== "chat") {
      if (client?.sessions === undefined) {
        message = "no gateway to list conversations from — start one with: crabby gateway start";
        return false;
      }
      sessionOverlay = true;
      sessionDeleteNote = undefined;
      void readSessions().then(drawNow);
      return false;
    }
    // T8's view is Ctrl+O — the one key the composer never claims in any pane, because C0 controls are not text. It
    // reads the conversation the composer would send into.
    if (key.kind === "ctrl" && key.letter === "o" && !help && !sessionOverlay) {
      if (client?.sessionContext === undefined) {
        message = "no gateway to read context from — start one with: crabby gateway start";
        return false;
      }
      contextOpen = true;
      contextConfirm = false;
      void readContext().then(drawNow);
      return false;
    }
    if (key.kind === "char" && key.char === "a" && !help) {
      if (approvals.length > 0) {
        approvalOpen = true;
        approvalIndex = 0;
        approvalConflict = false;
        draw();
        return false;
      }
    }
    if (key.kind === "ctrl" && key.letter === "c") {
      // T1-08: Ctrl-C cancels the task and does not quit. A second Ctrl-C is the way out, and it says so.
      if (running(tasks) === undefined) {
        quit = true;
        return true;
      }
      message = "cancelling the running task — press Ctrl-C again to quit anyway";
      void cancel(client as TaskReader, running(tasks)?.id ?? "").catch((error: unknown) => {
        message = `cancel failed: ${error instanceof Error ? error.message : String(error)}`;
      });
      return false;
    }
    if (key.kind === "ctrl" && key.letter === "q") {
      // T1-08: quitting with a running task confirms once, in words that say whether the task survives — it does, because
      // the run is the Gateway's, not this process's. The second press is the quit.
      if (running(tasks) !== undefined && !wasArmed) {
        quitArmed = true;
        // Worded to survive 40 columns whole: the fact the row demands (whether the task survives) is the prefix.
        message = "the task survives — Ctrl-Q again to quit";
        return false;
      }
      quit = true;
      return true;
    }
    // T1-08's suspend: cooked mode, then the signal — the terminal gets its cursor back and the shell does the rest.
    // The SIGCONT listener (registered beside the other signal work) re-enters raw mode and redraws, because a frame
    // half-erased by the terminal's suspend screen is not a frame this app drew.
    if (key.kind === "ctrl" && key.letter === "z" && !help) {
      renderer.printToScrollback(
        "suspended — the run keeps going on the gateway; fg brings this view back",
      );
      (
        options.suspend ??
        (() => {
          stdin.setRawMode?.(false);
          process.kill(process.pid, "SIGTSTP");
        })
      )();
      return false;
    }
    // T5-08's queue list. `q` in chat with anything waiting opens it (the hint strip says `q queue` while that is
    // true); when the buffer is empty and the queue is empty, `q` is still quit — the strip never lies about which.
    if (
      key.kind === "char" &&
      key.char === "q" &&
      !help &&
      pane === "chat" &&
      composer.buffer.length === 0 &&
      queue.length > 0
    ) {
      queueOpen = true;
      queueIndex = 0;
      return false;
    }
    // The same claim, held for quit itself: with words in the composer, `q` is a letter (T3-04 gives the composer every
    // printable key — and a draft containing "quiet" that quit the app was the bug this guard is).
    if (queueOpen) {
      if (key.kind === "escape") {
        queueOpen = false;
        return false;
      }
      if (
        key.kind === "up" ||
        key.kind === "down" ||
        (key.kind === "char" && (key.char === "j" || key.char === "k"))
      ) {
        const down = key.kind === "down" || (key.kind === "char" && key.char === "j");
        queueIndex = down
          ? Math.min(queue.length - 1, queueIndex + 1)
          : Math.max(0, queueIndex - 1);
        return false;
      }
      if (key.kind === "char" && (key.char === "u" || key.char === "n")) {
        // Reorder, in the list: `u` walks the row toward the front, `n` toward the back. The queue is order-sensitive —
        // it drains from the front — so a list without a way to change the order would be a list without a point.
        const index = queueIndex;
        const target = key.char === "u" ? index - 1 : index + 1;
        if (index >= 0 && target >= 0 && target < queue.length) {
          const next = [...queue];
          const item = next[index];
          if (item !== undefined && target !== index) {
            next[index] = next[target] as (typeof queue)[number];
            next[target] = item;
            queue = next;
            queueIndex = target;
          }
        }
        return false;
      }
      if (key.kind === "char" && key.char === "d") {
        const item = queue[queueIndex];
        queue = queue.filter((_, index) => index !== queueIndex);
        queueIndex = Math.max(0, Math.min(queueIndex, queue.length - 1));
        if (queue.length === 0) queueOpen = false;
        message = item === undefined ? "" : `dropped: ${item.objective.slice(0, 30)}`;
        return false;
      }
      if (key.kind === "enter") {
        // Send now: the person has decided this one cannot wait for the run to settle. It goes through the same send
        // the composer uses, one-turn facts included, and leaves the queue.
        const item = queue[queueIndex];
        if (item === undefined) return false;
        queue = queue.filter((_, index) => index !== queueIndex);
        queueIndex = Math.max(0, Math.min(queueIndex, queue.length - 1));
        if (queue.length === 0) queueOpen = false;
        const draft = { ...emptyComposer(), buffer: item.objective };
        void send(client, draft, transcript, { model: item.model }).then(
          (sent) => {
            transcript = noteTask(transcript, sent?.taskId);
            message = sent?.note;
            drawNow();
          },
          (error: unknown) => {
            message = `send failed: ${error instanceof Error ? error.message : String(error)}`;
            drawNow();
          },
        );
        return false;
      }
      return false;
    }
    if (
      key.kind === "char" &&
      key.char === "q" &&
      !help &&
      !(pane === "chat" && composer.buffer.length > 0)
    ) {
      // T1-08's confirm on the plain quit too: the task survives this process either way, and the words say so.
      if (running(tasks) !== undefined && !wasArmed) {
        quitArmed = true;
        message = "the task survives — q again to quit";
        return false;
      }
      quit = true;
      return true;
    }
    // T7's detail keys, over the tasks pane. Esc/q back, c cancels through the same route the tasks pane uses, r
    // resumes through `POST /tasks/{id}/resume`'s default (no body continues on the model the run was using), j/k page
    // the failure history (T7-09), t toggles the live tail (T7-13).
    if (pane === "tasks" && taskDetail !== undefined) {
      const id = taskDetail.record.id;
      if (key.kind === "escape" || (key.kind === "char" && key.char === "q")) {
        taskDetail = undefined;
        taskDetailScroll = 0;
        return false;
      }
      if (key.kind === "char" && key.char === "t") {
        taskDetail = { ...taskDetail, tail: !taskDetail.tail };
        return false;
      }
      if (key.kind === "char" && key.char === "c") {
        message = "cancelling — press Ctrl-C to confirm (T7-12: destructive asks first)";
        return false;
      }
      if (key.kind === "char" && key.char === "r") {
        if (client?.resumeTask === undefined) return false;
        void client
          .resumeTask(id)
          .then((response) => {
            const body = response.body as { note?: string } | null;
            message = body?.note ?? "the resume was asked for";
            return readTaskDetail(id).then(drawNow);
          })
          .catch(
            (error: unknown) =>
              (message = `resume refused: ${error instanceof Error ? error.message : String(error)}`),
          );
        return false;
      }
      if (key.kind === "char" && (key.char === "j" || key.char === "k")) {
        taskDetailScroll = Math.max(0, taskDetailScroll + (key.char === "j" ? 5 : -5));
        return false;
      }
      return false;
    }
    if (pane === "tasks" && taskDetail === undefined) {
      if (key.kind === "char" && key.char === "f" && !help) {
        taskFilterEditing = true;
        return false;
      }
      const visible = filterTasks(tasks, taskFilter);
      if (
        key.kind === "up" ||
        key.kind === "down" ||
        (key.kind === "char" && (key.char === "j" || key.char === "k"))
      ) {
        const down = key.kind === "down" || (key.kind === "char" && key.char === "j");
        taskIndex = down ? Math.min(visible.length - 1, taskIndex + 1) : Math.max(0, taskIndex - 1);
        return false;
      }
    }
    // The tasks pane: Enter opens T7's detail over the selected task (T7-13's tail turns on with it).
    if (
      pane === "tasks" &&
      key.kind === "enter" &&
      filterTasks(tasks, taskFilter).length > 0 &&
      client?.getTask !== undefined
    ) {
      const visibleTasks = filterTasks(tasks, taskFilter);
      const selected = visibleTasks[Math.min(taskIndex, visibleTasks.length - 1)];
      if (selected !== undefined) {
        void readTaskDetail(selected.id).then(drawNow);
      }
      return false;
    }
    // The jobs pane's keyboard (T17). A mode that is open owns the keys the way T1-07's modal does; the row keys act on
    // the selected job otherwise. Every act goes through the same routes `crabby job` uses — a keypress is a request to
    // the Gateway, never a second implementation of a pause.
    if (pane === "jobs") {
      const job = jobs[jobIndex];
      const refreshJobs = (): Promise<void> =>
        readJobs()
          .then(() => readJobDetailIntoState())
          .then(drawNow);
      const say = (text: string): void => {
        message = text;
      };
      // T17-06's form: single-line fields, Enter advances and saves. The composer's table types the field; `send` is
      // this form's "next", because a form with two fields has two "done"s and one key.
      if (jobEdit !== undefined) {
        if (key.kind === "escape") {
          jobEdit = undefined;
          message = "edit cancelled — nothing written";
          return false;
        }
        if (key.kind === "enter") {
          if (jobEdit.field === "schedule") {
            jobEdit = { ...jobEdit, field: "objective" };
            return false;
          }
          const form = jobEdit;
          jobEdit = undefined;
          const newSchedule = form.schedule.buffer.trim();
          const newObjective = form.objective.buffer.trim();
          void saveJobEdit(form.job, newSchedule, newObjective).then(say, (error: unknown) =>
            say(`edit failed: ${error instanceof Error ? error.message : String(error)}`),
          );
          return false;
        }
        const action = actionForKey(key);
        if (action !== undefined) {
          const current = jobEdit[jobEdit.field];
          const next = applyComposerAction(current, action);
          jobEdit = { ...jobEdit, [jobEdit.field]: next };
        }
        return false;
      }
      // T17-05's delete: the name typed back is the confirmation, and nothing else is.
      if (jobDelete !== undefined) {
        if (key.kind === "escape") {
          jobDelete = undefined;
          message = "delete cancelled";
          return false;
        }
        if (key.kind === "enter") {
          const typed = jobDelete.typed.buffer.trim();
          if (typed === jobDelete.job.name) {
            say(deleteGapLine(jobDelete.job));
            jobDelete = undefined;
          } else {
            say("the name does not match — nothing was deleted");
          }
          return false;
        }
        const action = actionForKey(key);
        if (action !== undefined) {
          jobDelete = { ...jobDelete, typed: applyComposerAction(jobDelete.typed, action) };
        }
        return false;
      }
      // T17-07's prompt: three answers, and Esc answers nothing (the rows stay).
      if (jobBacklog) {
        if (key.kind === "escape") {
          jobBacklog = false;
          say("no answer recorded — the missed rows stay until one is");
          return false;
        }
        if (key.kind === "char" && (key.char === "l" || key.char === "s")) {
          if (client?.jobBacklog === undefined || job === undefined) return false;
          const action = key.char === "l" ? "latest" : "skip";
          jobBacklog = false;
          void client
            .jobBacklog(job.id, { action })
            .then((response) => {
              const body = response.body as {
                note?: string;
                taskId?: string;
                acknowledged?: number;
              } | null;
              say(
                `${body?.note ?? "backlog answered"}${body?.taskId === undefined ? "" : ` (task ${body.taskId})`}`,
              );
              return refreshJobs();
            })
            .catch((error: unknown) =>
              say(
                `backlog answer failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          return false;
        }
        // D-133 retired the walk: `each` is a wire action now, and the scheduler performs the one-at-a-time drain the
        // client used to do by hand. The key's answer is one call, like `l` and `s`.
        if (key.kind === "char" && key.char === "e") {
          if (client?.jobBacklog === undefined || job === undefined) return false;
          jobBacklog = false;
          void client
            .jobBacklog(job.id, { action: "each" })
            .then((response) => {
              const body = response.body as {
                note?: string;
                taskId?: string;
                acknowledged?: number;
              } | null;
              say(
                `${body?.note ?? "backlog answered"}${body?.taskId === undefined ? "" : ` (task ${body.taskId})`}`,
              );
              return refreshJobs();
            })
            .catch((error: unknown) =>
              say(
                `backlog answer failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          return false;
        }
        return false;
      }
      // T17-04's detail: Esc closes it; the row keys still act (the detail is the same job).
      if (jobDetail !== undefined && key.kind === "escape") {
        jobDetail = undefined;
        return false;
      }
      if (job !== undefined && (key.kind === "up" || key.kind === "down")) {
        jobIndex =
          key.kind === "down" ? Math.min(jobs.length - 1, jobIndex + 1) : Math.max(0, jobIndex - 1);
        jobDetail = undefined;
        return false;
      }
      if (job !== undefined && key.kind === "char") {
        if (key.char === "j" || key.char === "k") {
          jobIndex =
            key.char === "j" ? Math.min(jobs.length - 1, jobIndex + 1) : Math.max(0, jobIndex - 1);
          jobDetail = undefined;
          return false;
        }
        if (key.char === "p") {
          if (client?.pauseJob === undefined || client.resumeJob === undefined) return false;
          const resuming = job.state === "paused";
          void (resuming ? client.resumeJob(job.id) : client.pauseJob(job.id))
            .then((response) => {
              say(
                (response.body as { note?: string } | null)?.note ??
                  (resuming ? "resumed" : "paused"),
              );
              return refreshJobs();
            })
            .catch((error: unknown) =>
              say(
                `${resuming ? "resume" : "pause"} failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          return false;
        }
        if (key.char === "n") {
          // T17-05's `n` runs now. A run-now is a fresh policy evaluation (§4.5) — a T2 or T3 step inside it asks at run
          // time exactly as a scheduled run would (W16-05's note, which the row shares).
          if (client?.runJob === undefined) return false;
          void client
            .runJob(job.id)
            .then((response) => {
              const body = response.body as { note?: string; taskId?: string } | null;
              say(
                `${body?.note ?? "ran once"}${body?.taskId === undefined ? "" : ` (task ${body.taskId})`}`,
              );
              return refreshJobs();
            })
            .catch((error: unknown) =>
              say(`run refused: ${error instanceof Error ? error.message : String(error)}`),
            );
          return false;
        }
        if (key.char === "e") {
          jobEdit = openEditForm(job);
          return false;
        }
        if (key.char === "d") {
          jobDelete = openDeleteConfirm(job);
          return false;
        }
        if (key.char === "b") {
          // The prompt needs the *rows* of the backlog (the walk names each due time), and they ride on the detail
          // answer — one request, which is why `GET /jobs/{id}` carries them (the contract's own reason).
          if (client?.job === undefined) return false;
          void client
            .job(job.id)
            .then((response) => {
              const detail = readJobDetail(response.body);
              jobMissed = detail.missedUnacknowledged;
              if (jobMissed.length === 0 && job.missed === 0) {
                say("no occurrence of this job passed while nothing was watching");
                return undefined;
              }
              jobBacklog = true;
              return undefined;
            })
            .then(drawNow)
            .catch((error: unknown) =>
              say(`job detail failed: ${error instanceof Error ? error.message : String(error)}`),
            );
          return false;
        }
      }
      if (key.kind === "enter" && job !== undefined && client?.job !== undefined) {
        void client
          .job(job.id)
          .then((response) => {
            const detail = readJobDetail(response.body);
            jobMissed = detail.missedUnacknowledged;
            jobDetail = jobDetailPane(detail, columns);
            return undefined;
          })
          .then(drawNow)
          .catch((error: unknown) =>
            say(`job detail failed: ${error instanceof Error ? error.message : String(error)}`),
          );
        return false;
      }
    }
    if (pane === "logs") {
      // T15's views cycle on `v` and T15-05's artifact is `d`: the same `findUnsafeShapes` refusal and the same
      // 0600 file `crabby diagnostics` writes, because a second writer of the bundle would be a second answer to
      // "what may a paste contain".
      if (key.kind === "char" && key.char === "v") {
        logsView = nextLogsView(logsView);
        if (logsView === "decisions") void readDecisions().then(drawNow);
        if (logsView === "clients") {
          revokeConfirmFor = undefined;
          mintNote = undefined;
          void readClients().then(readListener).then(drawNow);
        }
        if (logsView === "config") {
          configEditing = undefined;
          configBuffer = "";
          configDiff = undefined;
          readConfig();
        }
        return false;
      }
      // T14's access view: `r` prints what revocation will end and asks again (T14-03), `n` mints a pairing code for
      // the interface this code is being read into — a local action, D-053, with the host named (T14-02).
      if (logsView === "clients") {
        if (
          key.kind === "up" ||
          key.kind === "down" ||
          (key.kind === "char" && (key.char === "j" || key.char === "k"))
        ) {
          revokeConfirmFor = undefined;
          const down = key.kind === "down" || (key.kind === "char" && key.char === "j");
          clientIndex = down
            ? Math.min(clientRows.length - 1, clientIndex + 1)
            : Math.max(0, clientIndex - 1);
          return false;
        }
        if (key.kind === "char" && key.char === "r" && clientRows.length > 0) {
          const row = clientRows[clientIndex];
          if (row === undefined || client?.authRevoke === undefined) return false;
          if (revokeConfirmFor !== row.id) {
            revokeConfirmFor = row.id;
            return false;
          }
          revokeConfirmFor = undefined;
          void client
            .authRevoke(row.id)
            .then((response) => {
              const ended = (response.body as { readonly streamsEnded?: number }).streamsEnded;
              message =
                `revoked ${row.id}` +
                (typeof ended === "number" && ended > 0
                  ? ` — ${String(ended)} stream(s) ended`
                  : "");
              if (readCredentials(layout)?.clientId === row.id) {
                message = `${message} — that was this app's own identity; its token is dead`;
              }
              return readClients().then(drawNow);
            })
            .catch((error: unknown) => {
              message = `revoke failed: ${error instanceof Error ? error.message : String(error)}`;
              drawNow();
            });
          return false;
        }
        if (key.kind === "char" && key.char === "n" && !help) {
          if (client?.pairCode === undefined) return false;
          void client
            .pairCode({ name: `tui-minted-${String(Date.now() % 10000)}`, interface: "web" })
            .then((response) => {
              const body = response.body as {
                readonly code: string;
                readonly expiresAt: string;
                readonly capabilities: readonly string[];
              };
              const gatewayHost =
                listener === undefined
                  ? "this machine"
                  : `${listener.host}:${String(listener.port ?? "?")}`;
              mintNote = mintLinesFor(body, gatewayHost, columns);
              drawNow();
              return undefined;
            })
            .catch((error: unknown) => {
              message = `mint failed: ${error instanceof Error ? error.message : String(error)}`;
              drawNow();
            });
          return false;
        }
        return false;
      }
      // T13's config view: the write is the CLI's pipeline, and the confirm is the diff shown before it (T13-03).
      if (logsView === "config") {
        if (configEditing !== undefined) {
          if (key.kind === "escape") {
            configEditing = undefined;
            configBuffer = "";
            configDiff = undefined;
            message = "edit cancelled — nothing written";
            return false;
          }
          if (key.kind === "char") {
            configBuffer = configBuffer + key.char;
            configDiff = undefined;
            return false;
          }
          if (key.kind === "backspace") {
            configBuffer = configBuffer.slice(0, -1);
            configDiff = undefined;
            return false;
          }
          if (key.kind === "enter") {
            const entry = configRows[configIndex];
            if (entry === undefined) return false;
            if (configDiff === undefined) {
              configDiff = diffLines(
                entry.key,
                entry.value,
                parseValueForDiff(configBuffer),
                columns,
              );
              return false;
            }
            const loaded = loadConfig(layout);
            const result = applyEdit(
              { file: loaded.file, token: loaded.token },
              entry.key,
              configBuffer,
              writeConfig,
              layout,
            );
            configEditing = undefined;
            configBuffer = "";
            configDiff = undefined;
            message = result.message;
            if (result.ok) readConfig();
            drawNow();
            return false;
          }
          return false;
        }
        if (
          key.kind === "up" ||
          key.kind === "down" ||
          (key.kind === "char" && (key.char === "j" || key.char === "k"))
        ) {
          const down = key.kind === "down" || (key.kind === "char" && key.char === "j");
          configIndex = down
            ? Math.min(configRows.length - 1, configIndex + 1)
            : Math.max(0, configIndex - 1);
          return false;
        }
        if (key.kind === "enter") {
          const entry = configRows[configIndex];
          if (entry === undefined) return false;
          configEditing = entry.key;
          configBuffer = "";
          configDiff = undefined;
          return false;
        }
        return false;
      }
      if (key.kind === "char" && key.char === "d") {
        const diagnostics = client?.diagnostics;
        if (diagnostics === undefined) return false;
        void (async () => {
          try {
            const text = JSON.stringify((await diagnostics()).body, null, 2);
            const unsafe = findUnsafeShapes(text);
            if (unsafe.length > 0) {
              message =
                `refused — the report carries ${unsafe.join(", ")} (§4's promise is to refuse rather than ` +
                "redact after the fact)";
            } else {
              const written = writeDiagnosticsArtifact(text);
              message = diagnosticsLine(written.file, written.bytes);
            }
          } catch (error) {
            message = `diagnostics failed: ${error instanceof Error ? error.message : String(error)}`;
          }
          draw();
        })();
        return false;
      }
    }
    if (pane === "models") {
      const view = modelViews[modelIndex];
      // T12's view, on `t` — the models pane is "Providers/models/tools" in the review's own grouping, and a tool
      // list that lived nowhere would be a capability with no visible control (docs/INTERFACES_AND_API.md §8).
      if (toolsOpen) {
        if (key.kind === "escape" || (key.kind === "char" && key.char === "t")) {
          toolsOpen = false;
          toolExpanded = false;
          return false;
        }
        if (
          key.kind === "up" ||
          key.kind === "down" ||
          (key.kind === "char" && (key.char === "j" || key.char === "k"))
        ) {
          const down = key.kind === "down" || (key.kind === "char" && key.char === "j");
          toolIndex = down
            ? Math.min(toolRows.length - 1, toolIndex + 1)
            : Math.max(0, toolIndex - 1);
          toolExpanded = false;
          return false;
        }
        if (key.kind === "enter") {
          toolExpanded = !toolExpanded;
          return false;
        }
        return false;
      }
      if (key.kind === "char" && key.char === "t" && !help) {
        toolsOpen = true;
        void readTools().then(drawNow);
        return false;
      }
      // T11-03/04/08's editor: the typed fields use the composer's own key table (one answer to "where is the cursor"),
      // Space cycles a capability's three positions, Enter saves through `nextOverride` + `writeOverrideRecord` — the
      // same stored-value rules and the same storage path `crabby model edit` uses (D-064).
      if (modelEdit !== undefined) {
        if (key.kind === "escape") {
          modelEdit = undefined;
          message = "edit cancelled — nothing written";
          return false;
        }
        if (key.kind === "enter") {
          const form = modelEdit;
          modelEdit = undefined;
          void saveModelEdit(form).then(
            (text) => {
              message = text;
              draw();
            },
            (error: unknown) => {
              message = `edit failed: ${error instanceof Error ? error.message : String(error)}`;
              draw();
            },
          );
          return false;
        }
        if (key.kind === "up" || key.kind === "down") {
          const fields = 4 + SUPPORTED_FEATURES.length;
          modelEdit = {
            ...modelEdit,
            field:
              key.kind === "down"
                ? (modelEdit.field + 1) % fields
                : (modelEdit.field + fields - 1) % fields,
          };
          return false;
        }
        if (key.kind === "char" && key.char === " " && modelEdit.field >= 4) {
          const feature = SUPPORTED_FEATURES[
            modelEdit.field - 4
          ] as (typeof SUPPORTED_FEATURES)[number];
          modelEdit = {
            ...modelEdit,
            supports: {
              ...modelEdit.supports,
              [feature]: cycleChoice(
                modelEdit.supports[feature] as "auto" | "force on" | "force off",
              ),
            },
          };
          return false;
        }
        const field = modelEdit.field;
        const action = actionForKey(key);
        if (action !== undefined && field < 4) {
          const name = (["context", "maxOutput", "reserve", "notes"] as const)[field] as
            | "context"
            | "maxOutput"
            | "reserve"
            | "notes";
          modelEdit = { ...modelEdit, [name]: applyComposerAction(modelEdit[name], action) };
        }
        return false;
      }
      // T11-06's reset: one line naming what will be lost, and a second `r` is the only thing that removes it (W-O4's
      // destructive-never-pre-focused, in a terminal's shape).
      if (modelResetPending) {
        if (key.kind === "char" && key.char === "r" && view !== undefined) {
          modelResetPending = false;
          if (client === undefined) return false;
          void (async () => {
            const loaded = loadConfig(layout);
            const report = writeOverrideRecord(
              layout,
              loaded,
              view.provider,
              view.model,
              undefined,
            );
            readModels();
            message = report.ok
              ? "cleared — the reported descriptor is in force"
              : (report.message ?? "nothing was written");
            draw();
          })();
          return false;
        }
        modelResetPending = false;
        message = "kept — the overrides stand";
        return false;
      }
      if (
        key.kind === "up" ||
        key.kind === "down" ||
        (key.kind === "char" && (key.char === "j" || key.char === "k"))
      ) {
        const down = key.kind === "down" || (key.kind === "char" && key.char === "j");
        modelIndex = down
          ? Math.min(modelViews.length - 1, modelIndex + 1)
          : Math.max(0, modelIndex - 1);
        return false;
      }
      if (view !== undefined && key.kind === "char") {
        if (key.char === "e") {
          modelEdit = openModelForm(view);
          return false;
        }
        if (key.char === "r") {
          if (overrideFieldCount(view) === 0) {
            message = "this model has no override record — nothing to reset";
            return false;
          }
          modelResetPending = true;
          return false;
        }
      }
    }
    /** T5-03's execution half. The menu draws the commands; this maps the typed one onto a control that already exists —
     *  a pane, an overlay, the cancel route — because a slash command with its own private implementation of one of those
     *  would be a second implementation to keep true. Unknown words get T-O8's answer: the closest real command, named. */
    const executeSlash = (text: string): void => {
      const word = (text.split(/\s+/)[0] ?? "").toLowerCase();
      const rest = text.slice(word.length).trim();
      if (!SLASH_COMMANDS.some((command) => command === word)) {
        const close = SLASH_COMMANDS.find((command) => command.startsWith(word.slice(0, 3)));
        message =
          close === undefined
            ? `${word} is not a command here — the menu lists what is`
            : `${word} is not a command — the closest is ${close}`;
        return;
      }
      if (word === "/model") {
        if (rest.length === 0) {
          pane = "models";
          message = "the models pane — this is the visible control /model names";
          return;
        }
        const target = modelViews.find((view) => `${view.provider}/${view.model}` === rest);
        if (target === undefined) {
          message = `no model ${rest} is configured — the models pane lists what is`;
          return;
        }
        draftModel = rest;
        // D-045's delta, named before the turn is spent: tool calling is the loss a run cannot route around.
        const tools =
          target.effective?.supports.toolCalling ?? target.reported?.supports.toolCalling;
        const warning = modelSwitchWarning(tools === false ? ["tool calling"] : []);
        message = warning ?? `this turn will run on ${rest}`;
        return;
      }
      if (word === "/compact") {
        contextOpen = true;
        contextConfirm = false;
        void readContext().then(drawNow);
        return;
      }
      if (word === "/pin") {
        contextOpen = true;
        contextConfirm = false;
        pinTyping = true;
        pinBuffer = "";
        void readContext().then(drawNow);
        return;
      }
      if (word === "/task") {
        pane = "tasks";
        return;
      }
      if (word === "/cancel") {
        const run = running(tasks);
        if (run === undefined) {
          message = "nothing is running — /cancel would have stopped a task mid-step";
          return;
        }
        // T5-07's stop: the cancel route's finish-the-step semantics, in the body rather than in a comment, so the wire
        // carries what the hint says.
        void client
          ?.cancelTask(run.id, { mode: "finish-step" })
          .then(() => {
            message = "stop asked — the current step finishes, then the task settles";
            return readTasks().then(drawNow);
          })
          .catch((error: unknown) => {
            message = `cancel failed: ${error instanceof Error ? error.message : String(error)}`;
            drawNow();
          });
        return;
      }
      if (word === "/attach") {
        const typed = rest.trim();
        if (typed.length === 0) {
          message = "/attach takes a path — it rides the next send as text (T5-04)";
          return;
        }
        // The shell is not here to expand `~`, so the app does: a phone user typing `~/notes.txt` means their home, and
        // handing the checkPath a literal directory named `~` inside the workspace would check one file and read another.
        const path =
          typed === "~" || typed.startsWith("~/") ? os.homedir() + typed.slice(1) : typed;
        try {
          const config = loadConfig(layout);
          const roots = config.config.workspace?.roots ?? [];
          const verdict = checkPath(path, {
            home: os.homedir(),
            dataDir: layout.stateDir,
            roots,
          });
          if (!verdict.ok) {
            message = `refused: ${verdict.reason}`;
            return;
          }
          draftAttachments = [...draftAttachments, verdict.resolved];
          message = `attached ${verdict.resolved} — it rides the next send as text`;
        } catch (error) {
          message = `attach failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        return;
      }
    };

    // The composer owns every printable key when the chat pane is up (T3-04), and the pane's own bindings are read *after*
    // it — so a letter can never be swallowed by a pane binding and a pane binding can never eat a half-typed word.
    if (pane === "chat" && isComposerKey(key)) {
      const handled = chatKey(composer, previousInputs, key as ComposerKey, undefined);
      const draft = composer;
      if (handled.action === "send") {
        composer = emptyComposer();
      } else {
        composer = handled.composer;
      }
      if (handled.unbound !== undefined) {
        message = `${handled.unbound} is not bound here — this terminal has no Shift+Enter (D-061 measured that); use Ctrl+J for a newline`;
      }
      if (handled.action === "send") {
        const text = draft.buffer.trim();
        // An Enter on an empty composer is a key with nothing to do, and silence here reads as a hang (T3-03's rule in
        // the composer). It also guards the queue below: an empty objective would sit in the queue and send nothing
        // when the run settled, a ghost row that never acted.
        if (text.length === 0) {
          message = "nothing to send yet — type first";
          return false;
        }
        // The slash menu first (T5-03): a buffer that names a command is a control, not a message — the row's own rule
        // that every command also has a visible control is what keeps these mapped onto panes and overlays that exist.
        if (text.startsWith("/")) {
          composer = emptyComposer();
          executeSlash(text);
          return false;
        }
        // T5-08: while a task runs, a send *queues* rather than interrupts. The words stay visible in the queue, the
        // count is on the composer, and the queue's first row goes out when the run settles (the poll watches for it).
        if (running(tasks) !== undefined) {
          queue = [...queue, { objective: text, model: draftModel }];
          draftModel = undefined;
          draftAttachments = [];
          // The queue is a send that waits, and T5-09's history records what was typed — a queued line is as much a
          // previous input as one that went out at once, and a walk that skips it would forget words the person said.
          previousInputs.push(text);
          composer = emptyComposer();
          message = `queued — it sends when the run settles (${String(queue.length)} waiting)`;
          return false;
        }
        message = undefined;
        // The history records what was typed, not what was sent, and it records it before the send is attempted: a send that
        // fails must not erase the words a person just typed.
        if (text.length > 0) previousInputs.push(text);
        const model = draftModel;
        const attachments = draftAttachments;
        draftModel = undefined;
        draftAttachments = [];
        void send(client, draft, transcript, { model, attachments }).then(
          (sent) => {
            composer = emptyComposer();
            // T2-09: the id and the exact watch command each get a line of their own in the scrollback — lines a
            // long-press can take whole, whatever becomes of the message line above them.
            transcript = noteTask(transcript, sent?.taskId);
            message = sent?.note;
            // T8-08's numbers move with every turn: the next draft's warning is only as good as the last count.
            void refreshContext().then(drawNow);
          },
          (error: unknown) => {
            message = `send failed: ${error instanceof Error ? error.message : String(error)}`;
            drawNow();
          },
        );
      }
      return false;
    }
    if (key.kind === "tab") {
      pane = nextPane(pane);
      return false;
    }
    if (key.kind === "char" && "123456".includes(key.char)) {
      const index = Number(key.char) - 1;
      pane = PANE_ORDER[index] ?? pane;
      return false;
    }
    if (key.kind === "char" && key.char === "?") {
      help = !help;
      return false;
    }
    if (key.kind === "escape" && help) {
      help = false;
      return false;
    }
    // T3-03: a key that does nothing says so, with the pane's own first hint as the closest thing.
    if (key.kind === "unknown")
      message = unknownKeyLine(key.bytes, PANE_DESCRIPTORS[0]?.hints ?? []);
    else if (key.kind === "char")
      message = unknownKeyLine(key.char, PANE_DESCRIPTORS[0]?.hints ?? []);
    return false;
  };

  // The first frame, after the listeners exist — so a keystroke or an `end` arriving during the first draws is not lost.
  draw();

  stdin.on("data", onData);
  const poll = setInterval(() => {
    void readTasks()
      .then(() => readApprovals())
      .then(() => readJobs())
      .then(() => {
        readModels();
      })
      .then(() => (pane === "logs" ? readDecisions() : Promise.resolve()))
      .then(() =>
        pane === "tasks" && taskDetail !== undefined && taskDetail.tail
          ? readTaskDetail(taskDetail.record.id)
          : Promise.resolve(),
      )
      .then(draw)
      .then(() => {
        // T5-08's drain: the run settled, so the queue's first row goes out. One per poll — a burst of sends is what
        // the queue exists to prevent — and each carries the model it was queued with, not whatever is default now.
        if (queue.length === 0 || running(tasks) !== undefined) return Promise.resolve();
        const item = queue[0];
        if (item === undefined) return Promise.resolve();
        queue = queue.slice(1);
        const draft = { ...emptyComposer(), buffer: item.objective };
        return send(client, draft, transcript, { model: item.model }).then(
          (sent) => {
            transcript = noteTask(transcript, sent?.taskId);
            message = sent?.note;
            return refreshContext();
          },
          (error: unknown) => {
            message = `queued send failed: ${error instanceof Error ? error.message : String(error)}`;
            return refreshContext();
          },
        );
      });
  }, POLL_MS);
  const shutdown = (): void => {
    clearInterval(poll);
    // The socket closes with the app: a reader nobody cancels is a socket nobody closes, and Termux backgrounds this process
    // the moment the person switches away (D-066's drain is the other end of the same rule).
    stream?.close();
    stdin.off("data", onData);
    stdin.setRawMode?.(false);
    stdin.pause();
    renderer.showCursor();
    stop();
  };
  // T1-05's reflow: the terminal resized under the app — on a phone, the soft keyboard opening and closing is exactly
  // this, several times a minute. Re-measured through `terminalFacts` so the zero-report rule stays in one place, and
  // **debounced** because dragging a desktop terminal fires the signal faster than a phone can repaint. A change is
  // two assignments plus `invalidate()`: the renderer forgets the frame it drew for the old geometry, and the next
  // draw re-anchors and repaints whole — a line-diff against a frame that is no longer where it was would patch a
  // screen that is not there, which is the smear that read as doubled output on the owner's phone.
  const applyResize = (): void => {
    const next = terminalFacts(
      process.env,
      {
        ...(typeof process.stdout.columns === "number" ? { columns: process.stdout.columns } : {}),
        ...(typeof process.stdout.rows === "number" ? { rows: process.stdout.rows } : {}),
      },
      stdin.isTTY === true,
    );
    if (next.columns === columns && next.rows === rows) return;
    columns = next.columns;
    rows = next.rows;
    renderer.invalidate();
    drawNow();
  };
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      applyResize();
    }, 150);
  };
  process.on("SIGWINCH", onResize);
  const stopResize = (): void => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    process.off("SIGWINCH", onResize);
  };

  // The 50 ms tick is what turns a `quit` flag into a shutdown. **A `setInterval` rather than a busy loop**, because a
  // phone charging a frame per turn of the event loop is a phone that gets warm (§4 of `docs/DESIGN_SYSTEM.md`, and the
  // reason P-011 caps repaints at all).
  const tick = setInterval(() => {
    if (quit) {
      clearInterval(tick);
      stopResize();
      shutdown();
    }
  }, 50);
  await ended;
  clearInterval(tick);
  stopResize();
  shutdown();
  return EXIT.success;
}

/** The descriptor for a pane. A `find` with a fallback would let a pane name in the switch row exist without a descriptor,
 *  and the switch row is the frame's own address — an address with nothing at it is the defect T6-06 names. So the lookup
 *  falls back to a *descriptor*, never to `undefined`, and the fallback says which pane it is standing in for. */
/** The composer's key type, which is a subset of the decoder's. Narrowing here rather than widening the composer's signature
 *  is the point: the composer must never be handed a `tab` and must never be told to handle one. */
type ComposerKey = Parameters<typeof chatKey>[2];

/** The keys the composer claims when the chat pane is up. T3-04's rule is that a pane's bindings and the composer cannot
 *  overlap: `a` is an approve in the approvals pane and a letter here, so the composer's claim is checked *first* and the
 *  pane's bindings only see what the composer did not take. Tab, `?`, Ctrl-C and Ctrl-Q stay with the pane — a person must
 *  always be able to leave the pane and stop the run, whatever they are typing. */
function isComposerKey(key: Key): boolean {
  if (key.kind === "char") return true;
  if (key.kind === "ctrl") return key.letter === "j";
  // T5-09's arrows are the composer's *when the chat pane is up*: the condition that keeps them from stealing a scroll
  // key lives in `actionFor` (history only on an empty buffer, or a walk already running), because this chat pane binds
  // no scrolling to ↑/↓ — the panes that do scroll are other panes, and this claim is never consulted there.
  if (key.kind === "up" || key.kind === "down") return true;
  return (
    key.kind === "enter" || key.kind === "backspace" || key.kind === "left" || key.kind === "right"
  );
}

/** Sending is **starting a task**, which is D-123's shape and not a second writer of conversation history: the same
 * `POST /tasks` the CLI's `crabby chat` calls, with the session id when the pane is continuing one. The reply is the task id,
 *  and the pane prints it rather than hiding it — a person who wants to watch the run from a shell has the id, which is the
 *  same reasoning C11-06 gives for printing a conversation id. */
async function send(
  client: TaskReader | undefined,
  draft: ComposerState,
  from: TranscriptState,
  /** T5-05's one-turn model pin and T5-04's attached paths. Attachments travel **as text** — there is no upload field
   *  in this build's API and inventing an envelope would be a second format to keep true — so the paths ride the
   *  objective, clearly marked, and the run's own file tools (already §8-checked) read them. */
  options: {
    readonly model?: string | undefined;
    readonly attachments?: readonly string[];
  } = {},
): Promise<{ readonly note: string; readonly taskId: string | undefined } | undefined> {
  if (client === undefined) {
    return {
      note: "no gateway to send to — start one with: crabby gateway start",
      taskId: undefined,
    };
  }
  const text = draft.buffer.trim();
  if (text.length === 0) return undefined;
  const objective =
    options.attachments === undefined || options.attachments.length === 0
      ? text
      : `${text}\n[attached files: ${options.attachments.join(", ")}]`;
  const session = lastSession(from);
  const created = readTaskId(
    (
      await client.createTask(
        {
          objective,
          ...(session === undefined ? {} : { sessionId: session }),
          ...(options.model === undefined ? {} : { model: options.model }),
        },
        // An idempotency key derived from the words, so a retried send on a phone that lost its network does not start the task
        // twice. The Gateway owns what that key means (D-084's handoff); the TUI only has to supply one.
        `tui-${hash(objective)}`,
      )
    ).body,
  );
  // The pin's mortality is the draft line's job ("one-turn override" shows while typing, T5-05). The copyable facts go
  // back separately: T2-09 wants the task id on **its own short line** (Termux copies by long-press, and an id inside a
  // sentence is an id that gets clipped) and T-C8 wants the exact command whole — both lines are far under 40 columns,
  // so neither is ever cut. The `!` line keeps the verb and the one-turn model note.
  const turn = options.model === undefined ? "" : ` — this turn on ${options.model}`;
  return { note: `sent as task ${created}${turn}`, taskId: created };
}

/** The two bare lines a created task earns in the transcript (T2-09): the id, then the exact watch command. One place,
 *  because both callers — the live send and the queue drain — must agree on what a send leaves behind. */
function noteTask(transcript: TranscriptState, taskId: string | undefined): TranscriptState {
  if (taskId === undefined) return transcript;
  return addNote(addNote(transcript, taskId), `crabby task watch ${taskId}`);
}

/** The mint answer as drawn lines — `mintLines` over the response body, kept beside the other module-level helpers so
 *  the key handler stays a handler. */
function mintLinesFor(
  body: {
    readonly code: string;
    readonly expiresAt: string;
    readonly capabilities: readonly string[];
  },
  gatewayHost: string,
  columns: number,
): readonly string[] {
  return mintLines(body, gatewayHost, columns);
}

/** A stable-enough key from the words themselves. `Date.now()` would make every send unique, which is the opposite of what an
 *  idempotency key is for: a retry after a dropped connection must carry the *same* key. This is not a security primitive and
 *  is not used as one — it only has to be equal for equal text. */
function hash(text: string): string {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + (text.charCodeAt(index) | 0)) | 0;
  }
  return Math.abs(value).toString(36);
}

/** The conversation this transcript belongs to, when the frames said. Read from the transcript rather than held beside it, so
 *  there is one place that knows and a reconnect rebuilds it. */
function lastSession(state: TranscriptState): string | undefined {
  for (const row of state.rows) {
    if (row.kind === "system" && row.text.startsWith("session ")) return row.text.slice(8).trim();
  }
  return undefined;
}

function descriptorFor(pane: Pane): PaneDescriptor {
  const found = PANE_DESCRIPTORS.find((entry) => entry.pane === pane);
  if (found !== undefined) return found;
  return {
    pane,
    hints: ["Tab panes", "? help", "q quit"],
    built: false,
    milestone: "M3",
    equivalent: "crabby task ls",
  };
}

function running(tasks: readonly TaskSummary[]): TaskSummary | undefined {
  return tasks.find((task) => task.state === "running" || task.state === "awaiting_approval");
}

/** The cancel act, kept in one place so the verb and the key cannot differ: `POST /tasks/{id}/cancel`, which is the route
 *  the CLI's `task cancel` uses. D-090's record is the route's job — this only asks. */
async function cancel(client: TaskReader, id: string): Promise<void> {
  await client.cancelTask(id);
}
