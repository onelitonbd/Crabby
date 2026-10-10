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
  type CreateTaskBody,
  ErrorEnvelope,
  errorEnvelope,
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
  diagnostics(): Promise<Response<unknown>>;
  createTask(body: CreateTaskBody, idempotencyKey: string): Promise<Response<unknown>>;
  listTasks(options?: {
    state?: TaskState;
    limit?: number;
    cursor?: string;
  }): Promise<Response<unknown>>;
  getTask(id: string): Promise<Response<unknown>>;
  taskEvents(id: string, cursor?: number): Promise<Response<unknown>>;
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
    authList: () => request("/api/v1/auth/clients"),
    authRevoke: (id) =>
      request(`/api/v1/auth/clients/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
}
