// D-067's other half: the Web UI's files are served **by the Gateway, from this repository, on the same origin the API
// answers on** — one port, one loopback bind, no second process (`crabby web open` prints the URL and starts nothing).
// The client itself is D-068's framework-free custom elements, which is why there is no build step and no bundler
// here: the files under `apps/web` are the served bytes, verbatim.
//
// **Why the assets answer without a token when `SECURITY.md` §13 says "reject every route".** The sentence's scope is
// the API surface — the routes `printRoutes()` inventories and the security sweep in `tests/security/` walks. These
// files are not a route; they are the *client*, the same code a person would `scp` to their phone and open from
// `file://`. Serving them changes what the browser downloads, never what the Gateway does: every capability still sits
// behind the token, which the page obtains through `POST /api/v1/auth/pair` — the one route §3.1 exempts — and sends
// as a header, never a query string (`docs/INTERFACES_AND_API.md` §7.3). A test holds each half of that:
// `packages/gateway/web.test.ts` asserts the assets answer bare **and** that `/api/v1/health` next door still answers
// `401` without one.
//
// The handler is deliberately small and dependency-free: a containment check, a content-type map for the four kinds of
// file the client is made of, and `no-store`, because the assets ship with the Gateway and a cached page talking to a
// newer API is a drift a phone cannot see. Unknown paths answer `404` with a body that names nothing — the same rule
// the JSON not-found handler follows (§3.1: an unauthenticated probe learns nothing about what exists).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** `/web` (the app root) and `/web/…` (an asset). Anything else is not this handler's business. */
export function isWebPath(route: string): boolean {
  return route === "/web" || route === "/web/" || route.startsWith("/web/");
}

/** Resolve a request path to a file inside `root`, refusing everything that leaves it. `..` segments, absolute
 *  escapes and encoded tricks all end at the same `undefined`, because the only honest answer to "is this file
 *  inside the client directory?" is a resolved-path comparison, not a blacklist. */
export function resolveWebAsset(route: string, root: string): string | undefined {
  const relative =
    route === "/web" || route === "/web/" ? "index.html" : route.slice("/web/".length);
  if (relative.length === 0) return undefined;
  const resolved = path.resolve(root, relative);
  const contained = path.resolve(root);
  if (resolved !== contained && !resolved.startsWith(`${contained}${path.sep}`)) return undefined;
  return resolved;
}

/** The one answer a request for a client file can get. `false` means "not ours — fall through", which cannot happen
 *  when the caller checked `isWebPath` first but is the correct contract anyway: the hook composes, it does not own. */
export async function serveWebAsset(
  _request: FastifyRequest,
  reply: FastifyReply,
  root: string,
  route: string,
): Promise<boolean> {
  const file = resolveWebAsset(route, root);
  if (file === undefined || !(await isFile(file))) {
    // A miss says only "no": same body for a missing file and a refused path, so the two are not distinguishable
    // from outside (the not-found handler's rule, carried here).
    await reply.code(404).type("text/plain; charset=utf-8").send("not found");
    return true;
  }
  const body = await readFile(file);
  reply
    .code(200)
    .type(CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream")
    // The assets are versioned with the Gateway that serves them; a cached page against a newer API is a drift the
    // person cannot see, so nothing here is stored.
    .header("cache-control", "no-store")
    .send(body);
  return true;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
