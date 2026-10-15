// The client half of the Gateway contract, in this package so all four interfaces share it (D-005): the CLI, the
// TUI, the browser bundle and Telegram should be unable to disagree about URLs, headers or error shapes because they
// are literally running the same file.
//
// Origin discovery is a filesystem read, not a guess. No document names a port — the probes print "the OS chose a
// port" for exactly that reason — so the Gateway writes what it bound to into its own state directory and clients
// read it. D-078 records the name; §10's "clients must discover rather than assume" is the rule it serves.
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  type CancelTaskBody,
  type CreateSessionBody,
  type CreateTaskBody,
  ErrorEnvelope,
  errorEnvelope,
  type JobBacklogBody,
  type PatchJobBody,
  type PatchSessionBody,
  type ResumeTaskBody,
  type TaskState,
  validate,
} from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";

export const GATEWAY_INFO_FILE = "gateway.json";
export const CLIENT_FILE = "client.json";

export interface GatewayInfo {
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly version: string;
}

export interface ClientCredentials {
  readonly url: string;
  readonly token: string;
  readonly clientId: string;
  readonly pairedAt: string;
}

export function gatewayInfoPath(layout: DataLayout): string {
  return path.join(layout.stateDir, GATEWAY_INFO_FILE);
}

export function credentialsPath(layout: DataLayout): string {
  return path.join(layout.stateDir, CLIENT_FILE);
}

/** 0600 because the file names a pid and a port: not a secret by itself, but "there is a listener on this exact port
 *  of this exact machine" is a fact worth withholding from a shared home directory on a phone. */
export function writeGatewayInfo(layout: DataLayout, info: GatewayInfo): void {
  const file = gatewayInfoPath(layout);
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* as with the credentials file: a filesystem that will not set the mode is not one this can force */
  }
}

export function clearGatewayInfo(layout: DataLayout): void {
  const file = gatewayInfoPath(layout);
  if (existsSync(file)) unlinkSync(file);
}

export function readGatewayInfo(
  layout: DataLayout,
):
  | { state: "absent" }
  | { state: "stale"; info: GatewayInfo }
  | { state: "live"; info: GatewayInfo } {
  const file = gatewayInfoPath(layout);
  if (!existsSync(file) || readFileSync(file, "utf8").trim().length === 0)
    return { state: "absent" };
  // A file whose pid is dead is *stale*, and the distinction is the point: "a Gateway is running" and "someone left a
  // note behind" need different fixes, and `crabby gateway start` overwriting it is safe either way.

  let info: GatewayInfo;
  try {
    info = JSON.parse(readFileSync(file, "utf8")) as GatewayInfo;
  } catch {
    return {
      state: "stale",
      info: { host: "unknown", port: 0, pid: -1, startedAt: "", version: "unknown" },
    };
  }
  return isPidAlive(info.pid) ? { state: "live", info } : { state: "stale", info };
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else; anything else means it does not exist.
    return (
      typeof error === "object" && error !== null && (error as { code?: string }).code === "EPERM"
    );
  }
}

/** A token is a secret, so it is written owner-only in the client's config location (§3.1) and never in
 *  `config.json`, which `AGENTS.md` names as an anti-pattern for exactly this. */
export function writeCredentials(layout: DataLayout, credentials: ClientCredentials): void {
  const file = credentialsPath(layout);
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* a filesystem that will not grant the mode has nothing to hide the value from; the write itself is the same */
  }
}

export function readCredentials(layout: DataLayout): ClientCredentials | undefined {
  const file = credentialsPath(layout);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ClientCredentials;
  } catch {
    return undefined;
  }
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "DELETE" | "PATCH";
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
}

export interface Response<T> {
  readonly status: number;
  readonly ok: boolean;
  readonly body: T;
  readonly requestId?: string;
}

export interface GatewayClient {
  readonly url: string;
  request<T = unknown>(route: string, options?: RequestOptions): Promise<Response<T>>;
  health(): Promise<Response<unknown>>;
  status(): Promise<Response<unknown>>;
  /** §8's "List tools + tiers" row, over the registry in `@crabby/policy`. */
  tools(): Promise<Response<unknown>>;
  diagnostics(): Promise<Response<unknown>>;
  createTask(body: CreateTaskBody, idempotencyKey: string): Promise<Response<unknown>>;
  listTasks(options?: {
    state?: TaskState;
    limit?: number;
    cursor?: string;
  }): Promise<Response<unknown>>;
  getTask(id: string): Promise<Response<unknown>>;
  taskEvents(id: string, cursor?: number): Promise<Response<unknown>>;
  /** §4.3's checkpoint view (D-095): the boundary a run last committed, its size, and D-065's verdict on resuming from
   *  it. A task that never reached a step boundary answers `404` with the verdict's reason in `details`, so "no saved
   *  state" and "a task you may not see" are different responses. */
  taskCheckpoint(id: string): Promise<Response<unknown>>;
  /** §6.1's cancellation request, and the one mutating route here that takes no idempotency key on purpose: the manager
   *  already answers a second request for the same task with the request it recorded (`deduplicated`), and a second
   *  request that escalates to `immediate` is §6.2's override rather than a replay. A key cache would have to choose
   *  between those two readings and would get one of them wrong. */
  cancelTask(id: string, body?: CancelTaskBody): Promise<Response<unknown>>;
  /** D-044's answer, over the route §4.3 documents. An empty body is a real answer — "the same model again, with a fresh
   *  budget" — and a `model` switches to a pair the Gateway resolves against the pool the ask was built from, so a client
   *  never has to know which providers composed. No idempotency key, for the same reason `cancelTask` has none: the run
   *  is either parked (and this wakes it) or not (and this refuses), and a replay of a wake is a wake the task's own state
   *  machine then refuses. */
  resumeTask(id: string, body?: ResumeTaskBody): Promise<Response<unknown>>;
  /** §4.3's queue. `state` defaults to the only value a client can act on, and is passed through as text so a typo is
   *  refused by the Gateway rather than answered with an empty list. */
  approvals(options?: { state?: string }): Promise<Response<unknown>>;
  /** §4.3's decision. The key is optional — the row already refuses a second answer, which is why a lost response is
   *  a replay convenience here and a requirement for `createTask`. */
  decideApproval(
    id: string,
    body: { decision: "approve" | "deny"; scope?: string },
    idempotencyKey?: string,
  ): Promise<Response<unknown>>;
  /** §4.5's list, and the read half of D-057's first-class surface: the rows every interface's `Scheduled` view answers
   *  from. `state` is passed through as text so a typo is refused by the Gateway rather than answered with an empty list
   *  that reads as "you have no jobs". */
  jobs(options?: { state?: string }): Promise<Response<unknown>>;
  /** One job with its run history, its unacknowledged `missed` rows and the wall-clock stamp beside the UTC instant
   *  (D-103) — the whole of C12-02's fifteen lines and W16-08's sheet, in one request. */
  job(id: string): Promise<Response<unknown>>;
  /** The non-material half of an edit: a name and a schedule. `objective` is not a field of `PatchJobBody` at all,
   *  because changing what a job does crosses into re-approval (§4.5) and no route can open one (D-084). */
  patchJob(id: string, body: PatchJobBody): Promise<Response<unknown>>;
  /** C12-03's pause, which takes effect before the next tick. A run already in flight keeps going and is stopped through
   *  `cancelTask` — the same act §4.5 says a job is cancellable by. */
  pauseJob(id: string): Promise<Response<unknown>>;
  /** C12-03's resume. It re-evaluates the creating identity's *current* grants rather than restoring the ones recorded at
   *  creation (D-054), and refuses when they no longer cover the job, so a revoked client cannot be revived by a timer. */
  resumeJob(id: string): Promise<Response<unknown>>;
  /** C12-04's explicit run outside the schedule, which changes nothing about the schedule. A fresh policy evaluation, so
   *  it can stop at an approval — §7.1's exit `3` and not a silent nothing. */
  runJob(id: string): Promise<Response<unknown>>;
  /** C12-06's answer to §4.5's backlog. `action` is required on the wire for the reason the CLI asks rather than defaults:
   *  one of the two choices fires work, and §4.5's sixth rule is that a backlog must not run unannounced. */
  jobBacklog(id: string, body: JobBacklogBody): Promise<Response<unknown>>;
  /** §2.5's turns, one page at a time (D-112). `cursor` is the ordinal of the last turn a page carried, so a caller that
   *  appends while it reads cannot see a page shift; `limit` is the route's bound rather than this client's, because a bound
   *  the client could raise is not a bound. */
  sessionMessages(
    id: string,
    options?: { cursor?: number; limit?: number },
  ): Promise<Response<unknown>>;
  /** D-027's manual compaction: the same act the runtime performs at the budget, asked for by hand (D-113,
   *  D-118). No body — there is nothing to say beyond "now", and a body field would be a second way to ask for
   *  the same thing with different words. */
  compactSession(id: string): Promise<Response<unknown>>;
  /** D-119: protect a turn or a range of them from compaction. Ordinals, because that is what the transcript
   *  prints; `from === through` is a single turn and the route treats it as one. */
  pinMessages(id: string, range: { from: number; through: number }): Promise<Response<unknown>>;
  /** Unpin by the turn's own id — removing a *range* would have to guess whether it means "everything in it"
   *  or "what I added", and a wrong guess there silently protects or drops turns the user did not name. */
  unpinMessage(id: string, messageId: string): Promise<Response<unknown>>;
  /** §8.1's read half: what is in budget, what has been compacted, what is pinned. */
  sessionContext(id: string): Promise<Response<unknown>>;
  /** C11-01's list: conversations in last-activity order, each with the state word and title a list line prints. */
  sessions(options?: { origin?: string }): Promise<Response<unknown>>;
  /** One conversation with the tasks in it, and the `etag` that a rename has to send back as `If-Match`. */
  session(id: string): Promise<Response<unknown>>;
  /** W15-03's creation: `{}` is a valid body, because a new session starts empty and un-named. */
  createSession(body?: CreateSessionBody): Promise<Response<unknown>>;
  /** W15-04 and T16-05's one write path. The token is required by §2's concurrency row, so it is a parameter rather than
   *  an option: a client that could forget it would be a client that silently overwrites another interface's rename. */
  patchSession(id: string, body: PatchSessionBody, ifMatch: number): Promise<Response<unknown>>;
  authList(): Promise<Response<unknown>>;
  authRevoke(id: string): Promise<Response<unknown>>;
}

export class GatewayFailure extends Error {
  readonly status: number;
  readonly envelope: ReturnType<typeof errorEnvelope>;

  constructor(status: number, envelope: ReturnType<typeof errorEnvelope>) {
    super(envelope.error.message);
    this.name = "GatewayFailure";
    this.status = status;
    this.envelope = envelope;
  }
}

export function createClient(input: {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): GatewayClient {
  const base = input.url.replace(/\/$/, "");
  const doFetch = input.fetchImpl ?? fetch;

  async function request<T>(route: string, options: RequestOptions = {}): Promise<Response<T>> {
    const headers: Record<string, string> = {
      accept: "application/json; charset=utf-8",
      ...options.headers,
    };
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      body = JSON.stringify(options.body);
    }
    const response = await doFetch(`${base}${route}`, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const requestId = response.headers.get("x-crabby-request-id") ?? undefined;
    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
    if (!response.ok) {
      const checked =
        parsed !== null && typeof parsed === "object" && "error" in parsed
          ? validate(ErrorEnvelope, parsed)
          : undefined;
      const envelope = checked?.ok
        ? checked.value
        : errorEnvelope({
            code: `http_${response.status}`,
            message: `the Gateway answered ${response.status} with a body that is not an error envelope`,
            // The class is `internal` because a malformed error is the Gateway's fault, not the caller's.
            class: "internal",
            retryable: false,
          });
      throw new GatewayFailure(response.status, { error: envelope.error });
    }
    return {
      status: response.status,
      ok: true,
      body: parsed as T,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  return {
    url: base,
    request,
    health: () => request("/api/v1/health"),
    status: () => request("/api/v1/status"),
    tools: () => request("/api/v1/tools"),
    diagnostics: () => request("/api/v1/diagnostics"),
    createTask: (body, idempotencyKey) =>
      request("/api/v1/tasks", { method: "POST", body, idempotencyKey }),
    listTasks: (options = {}) => {
      const params = new URLSearchParams();
      if (options.state) params.set("state", options.state);
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.cursor) params.set("cursor", options.cursor);
      const query = params.toString();
      return request(`/api/v1/tasks${query.length > 0 ? `?${query}` : ""}`);
    },
    getTask: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}`),
    taskEvents: (id, cursor) =>
      request(
        `/api/v1/tasks/${encodeURIComponent(id)}/events${cursor === undefined ? "" : `?cursor=${cursor}`}`,
      ),
    taskCheckpoint: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}/checkpoint`),
    cancelTask: (id, body) =>
      request(`/api/v1/tasks/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        // An explicit `{}` rather than no body at all, so the wire shape is the same whether or not the caller has a mode
        // to ask for: `CancelTaskBody`'s fields are optional but the schema is an object, and a client that sent nothing
        // would be relying on the Gateway to guess what "nothing" means.
        body: body ?? {},
      }),
    resumeTask: (id, body) =>
      request(`/api/v1/tasks/${encodeURIComponent(id)}/resume`, {
        method: "POST",
        // Same reasoning as the cancel route above: an answer with no model is the "same model again" answer, and sending
        // `{}` makes that explicit on the wire rather than leaving the Gateway to read an absent body as a question it
        // should refuse.
        body: body ?? {},
      }),
    approvals: (options = {}) =>
      request(
        `/api/v1/approvals${options.state === undefined ? "" : `?state=${encodeURIComponent(options.state)}`}`,
      ),
    decideApproval: (id, body, idempotencyKey) =>
      request(`/api/v1/approvals/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        body,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),
    jobs: (options = {}) =>
      request(
        `/api/v1/jobs${options.state === undefined ? "" : `?state=${encodeURIComponent(options.state)}`}`,
      ),
    job: (id) => request(`/api/v1/jobs/${encodeURIComponent(id)}`),
    patchJob: (id, body) =>
      request(`/api/v1/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    pauseJob: (id) =>
      request(`/api/v1/jobs/${encodeURIComponent(id)}/pause`, { method: "POST", body: {} }),
    resumeJob: (id) =>
      request(`/api/v1/jobs/${encodeURIComponent(id)}/resume`, { method: "POST", body: {} }),
    runJob: (id) =>
      request(`/api/v1/jobs/${encodeURIComponent(id)}/run`, { method: "POST", body: {} }),
    jobBacklog: (id, body) =>
      request(`/api/v1/jobs/${encodeURIComponent(id)}/backlog`, { method: "POST", body }),
    sessions: (options = {}) =>
      request(
        `/api/v1/sessions${options.origin === undefined ? "" : `?origin=${encodeURIComponent(options.origin)}`}`,
      ),
    session: (id) => request(`/api/v1/sessions/${encodeURIComponent(id)}`),
    createSession: (body = {}) => request("/api/v1/sessions", { method: "POST", body }),
    patchSession: (id, body, ifMatch) =>
      request(`/api/v1/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
        headers: { "if-match": `"${ifMatch}"` },
      }),
    sessionMessages: (id, options = {}) => {
      const params = new URLSearchParams();
      if (options.cursor !== undefined) params.set("cursor", String(options.cursor));
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      const query = params.toString();
      return request(
        `/api/v1/sessions/${encodeURIComponent(id)}/messages${query.length > 0 ? `?${query}` : ""}`,
      );
    },
    compactSession: (id) =>
      request(`/api/v1/sessions/${encodeURIComponent(id)}/compact`, { method: "POST" }),
    pinMessages: (id, range) =>
      request(`/api/v1/sessions/${encodeURIComponent(id)}/pin`, {
        method: "POST",
        body: range,
      }),
    unpinMessage: (id, messageId) =>
      request(`/api/v1/sessions/${encodeURIComponent(id)}/pin/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
      }),
    sessionContext: (id) => request(`/api/v1/sessions/${encodeURIComponent(id)}/context`),
    authList: () => request("/api/v1/auth/clients"),
    authRevoke: (id) =>
      request(`/api/v1/auth/clients/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
}
