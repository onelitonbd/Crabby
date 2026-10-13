// §3.3's "Custom-provider requirements" as one implementation both adapters call, because a rule written twice is a rule
// that drifts: the fake is §7's reference adapter, and a reference that validates configuration differently from the
// product adapter teaches the wrong thing about what "rejects unusable configuration with an actionable reason" (§3.1)
// means.
//
// The four rejections are §3.3's base-URL rules plus the two the fake already had. The one addition that needed a
// contract change is the *warning*: §3.3 requires "a clear warning if the host is not loopback while the key would be sent
// over plain HTTP", and a warning is not a rejection — a LAN `llama-server` on plain HTTP with a key is a configuration a
// user may legitimately choose, so refusing it would be the adapter making a security decision the document assigned to
// the user. `ConfigValidation` therefore carries `warnings` on the accepted arm (D-100), and the sentence that owns the
// requirement is §3.3's rather than a comment here.
//
// What this file deliberately does not do is resolve a credential. §3.7 says a key lives in the vault and is referenced by
// name (`provider.groq.key = vault://groq`), with the adapter receiving "a handle that yields the value at call time".
// This build has no vault code — `packages/gateway/app.ts` reports `vault: { managed: false }` rather than claiming a
// lock it cannot show — so `ProviderConfig.apiKey` is a plain string and whoever composes an adapter is the party that
// must keep it out of a log (`packages/core/redact.ts`) and out of model context. `docs/CONSISTENCY_REVIEW.md` F-56 is
// where that gap is recorded; nothing here pretends to close it.

import type { ConfigValidation, ProviderConfig } from "./contract.ts";

const KNOWN_FIELDS: readonly string[] = ["baseUrl", "apiKey", "headers"];

/** The loopback hosts §3.3's warning exempts. Measured on the hostname rather than on a range, for the same reason
 *  `requireLoopback` in the Gateway is fail-closed about addresses: an in-range neighbour of `127.0.0.1` is a host a
 *  client went looking for, and "loopback" in this sentence means "this device". */
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}

/** §3.1's `validateConfig`, implemented once. Returns a reason that names the field at fault, because "unusable" is not
 *  actionable and §3.1 asks for actionable. */
export function validateProviderConfig(config: ProviderConfig): ConfigValidation {
  if (typeof config?.baseUrl !== "string" || config.baseUrl === "") {
    return {
      ok: false,
      reason: "'baseUrl' is required: without it there is no endpoint to call",
    };
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    return { ok: false, reason: `'baseUrl' is not a URL (${config.baseUrl})` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `'baseUrl' must be http(s), got '${url.protocol}'` };
  }
  // §3.3: "no embedded credentials in the URL". A key in a URL is a key in a shell history, in `gateway.json`'s neighbour
  // config file, in every access log the endpoint keeps, and in the `subject` of any error message that quotes the
  // request — which is why this is a rejection and the plain-HTTP case below is only a warning.
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason:
        "'baseUrl' must not carry credentials (a `user:pass@host` URL puts the key in every log and history that records " +
        "it); send it as 'apiKey', which §3.7 keeps in the vault",
    };
  }
  if (config.apiKey !== undefined && typeof config.apiKey !== "string") {
    return { ok: false, reason: "'apiKey' must be a string when present" };
  }
  if (config.headers !== undefined) {
    const bad = Object.entries(config.headers).filter(([, value]) => typeof value !== "string");
    if (bad.length > 0) {
      return {
        ok: false,
        reason: `'headers' values must be strings (${bad.map(([key]) => key).join(", ")})`,
      };
    }
  }
  const unknown = Object.keys(config).filter((key) => !KNOWN_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, reason: `unknown configuration field(s): ${unknown.join(", ")}` };
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && config.apiKey !== undefined) {
    return {
      ok: true,
      warnings: [
        `'baseUrl' is plain HTTP to ${url.hostname}, which is not this device, so 'apiKey' would be sent in the clear. ` +
          "A local server on a LAN is a legitimate setup (§3.3 accepts it) and this is the user's decision to make — " +
          "it is reported rather than refused, and every interface shows the endpoint while a task runs.",
      ],
    };
  }
  return { ok: true };
}
