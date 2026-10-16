// The hash router: `#/chat`, `#/tasks/tsk_1`, `#/settings/access` — parsed to a plain object by a pure function the
// tests hold, applied to `location.hash` by `app.js` alone. Hash routing rather than the History API is a Termux
// decision, not a habit: the Gateway serves one `index.html` and there is no server-side rewrite to back a pushState
// path, and W-O8's "404 redirects home with a note" is a client fact here.
//
// The five primary destinations are W2-01's tabs; `context` and `settings/*` are reachable from the shell and from
// chips (W1-03, W4-06, W7). Unknown screens fall to `chat` — W-O8's "redirect home with a note" is the caller's job
// because the router is pure and cannot see the page.

const SCREENS = ["chat", "tasks", "jobs", "approvals", "sessions", "settings", "context"];

/** Older hashes named some settings subtabs at the top level; they normalize rather than 404 (W-O8's spirit:
 *  a link the shell once rendered must still land somewhere true). */
const SETTINGS_ALIASES = ["access", "models", "tools", "logs", "memory", "extensions"];

/** `parse("#/tasks/tsk_1?x=1")` → `{ screen: "tasks", rest: ["tsk_1"], query: {x:"1"} }`. Empty or unknown → chat. */
export function parseHash(hash) {
  const raw = String(hash ?? "").replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter((s) => s.length > 0);
  const screen = SCREENS.includes(segments[0]) ? segments[0] : "chat";
  const query = {};
  if (queryPart !== undefined) {
    for (const pair of queryPart.split("&")) {
      const [k, v = ""] = pair.split("=");
      if (k.length > 0) query[safeDecode(k)] = safeDecode(v);
    }
  }
  if (segments[0] !== undefined && SETTINGS_ALIASES.includes(segments[0])) {
    return { screen: "settings", rest: segments.slice(0), query };
  }
  // Encoded segments round-trip: hashFor encodes, parseHash decodes — the same word comes back. `unknown` is set
  // only when the hash *named* a screen that does not exist — the W-O8 note's evidence. A plain `#/chat` carries
  // none, because arriving home is not a redirect when home is where you pointed.
  const unknown =
    segments[0] !== undefined && !SCREENS.includes(segments[0]) ? segments[0] : undefined;
  return {
    screen,
    rest: segments.slice(1).map(safeDecode),
    query,
    ...(unknown === undefined ? {} : { unknown }),
  };
}

function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** The inverse, for links the shell renders. Values are encodeURIComponent-ed — a task id is data, not markup. */
export function hashFor(screen, segments = [], query = {}) {
  const path = [screen, ...segments].map(encodeURIComponent).join("/");
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `#/${path}${qs.length > 0 ? `?${qs}` : ""}`;
}
