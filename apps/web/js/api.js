// The browser's half of §3.1: one token, sent as a header, **never in a URL or a query string** (`INTERFACES_AND_API.md`
// §7.3 / F-53), stored in `localStorage` under one key after `POST /api/v1/auth/pair` redeems a pairing code — the same
// single-use, two-minute code `crabby auth pair` prints (§3.2). Revocation is the control, exactly as for the CLI and
// the TUI: no expiry by default (D-051), a revoked identity's next request answers `401` and this module clears itself.
//
// Events ride the same origin on `GET /api/v1/events` — an SSE *fetch*, not `EventSource`, because EventSource cannot
// carry an Authorization header and the token is not allowed in a query string. The parser below is the transport's
// (§7.2): `event:` names the family, `data:` is the envelope, `gap` and `end` are the two synthesized names
// `packages/gateway/sse.ts` writes.

const TOKEN_KEY = "crabby.web.token";
const BASE = "/api/v1";

export function readToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeToken(token) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // A private-mode browser that refuses storage is a session-scoped tab: the token lives in memory only, which is
    // *more* conservative, so swallowing the failure is the correct direction.
    memoryToken = token;
  }
}

let memoryToken;

/** The effective token — storage first, then the in-memory fallback. */
export function token() {
  return readToken() ?? memoryToken;
}

export function clearToken() {
  memoryToken = undefined;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Same reasoning as writeToken's catch.
  }
}

/** The error every failure becomes: the envelope's `code` and one human `message` (§3.2's rule lives on the Gateway;
 *  this class just carries it), plus `status` for the two behaviors callers own (401 → pair again; 409 → conflict). */
export class GatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** One request. `body` is JSON-encoded; the answer's envelope is unwrapped; a Gateway error envelope becomes a
 *  `GatewayError`; a network failure becomes a `GatewayError` with `code: "network"` so callers handle one type. */
export async function request(path, options = {}) {
  const headers = { accept: "application/json" };
  const t = token();
  if (t !== undefined) headers.authorization = `Bearer ${t}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  // The optimistic-concurrency headers the write routes demand: `If-Match` carries the document's own token
  // (`GET /config`'s etag, a session's `revision` etag) so a write made from a stale read is refused, not merged.
  if (options.ifMatch !== undefined) headers["if-match"] = options.ifMatch;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new GatewayError(
      0,
      "network",
      `the gateway is not reachable (${String(error?.message ?? error)})`,
    );
  }
  if (response.status === 401) clearToken();
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    // A non-JSON body from a non-API answer: wrapped below with the status it came with.
  }
  if (!response.ok) {
    const error = body?.error;
    throw new GatewayError(
      response.status,
      error?.code ?? `http_${String(response.status)}`,
      error?.message ?? `the gateway answered ${String(response.status)}`,
    );
  }
  return body;
}

/** The stream. Yields parsed frames `{ id, type, ... }`; calls `onOpen` when the connection is up so the shell can flip
 *  W1-04's chip to `live`. Reconnection is the caller's (the shell's) job, with the same one-retry policy the TUI keeps. */
export async function followEvents({ onFrame, onOpen, onClose, signal }) {
  const headers = { accept: "text/event-stream" };
  const t = token();
  if (t !== undefined) headers.authorization = `Bearer ${t}`;
  let response;
  try {
    response = await fetch(`${BASE}/events`, { headers, signal });
  } catch (error) {
    onClose?.(`the stream could not open (${String(error?.message ?? error)})`);
    return;
  }
  if (!response.ok || response.body === undefined) {
    onClose?.(`the stream answered ${String(response.status)}`);
    return;
  }
  onOpen?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const frame = parseBlock(block);
      if (frame !== undefined) onFrame(frame);
    }
  }
  onClose?.("the stream closed");
}

function parseBlock(block) {
  let event = "message";
  let data;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (data === undefined) return undefined;
  try {
    const parsed = JSON.parse(data);
    return event === "message" ? parsed : { ...parsed, type: event };
  } catch {
    return undefined;
  }
}
