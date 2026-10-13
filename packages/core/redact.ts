// One redaction module, because `SECURITY.md` §7 puts the obligation at the serializer rather than at the screen:
// "Redaction is applied at the logging and event-serialization layer, not only at the UI. If an error object can
// contain a header, the serializer must strip it." Four surfaces, an event stream and a log file all need the *same*
// answer, and a filter written per surface drifts. D-066 already removed the hardest case at the source — no secret
// material in the database at all, rows carry `vault://<name>` references — so this is defence in depth, not the
// boundary.
import { isSecretShaped } from "@crabby/api-contracts";

const KEY_RE =
  /(authorization|api[-_]?key|token|secret|password|passphrase|private[-_]?key|seed|credential|session[-_]?id)/i;
const NAME_RE = /(^|[^a-z0-9])(sk|ghp|gho|ghs|github_pat|xox[baprs]|ya29)[.-][A-Za-z0-9_-]{6,}/gi;

/** The one word this build puts where a secret was. Exported because a second spelling in a second module is the drift
 *  this file's header exists to prevent: a reader of a config answer and a reader of a log line have to see the same
 *  marker to know the same thing happened. */
export const REDACTED_MARKER = "[redacted]";

function mask(value: string): string {
  if (value.length <= 8) return REDACTED_MARKER;
  return `${value.slice(0, 4)}…${value.slice(-2)} ${REDACTED_MARKER}`;
}

/** Value-level scrub: any string under a key that looks like a credential is replaced, and any string that itself
 *  looks like a secret is replaced wherever it sits. It errs towards masking — a truncated stack trace in a log is
 *  a nuisance, a leaked provider key is an incident. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 32) return "[redacted: too deep]" as unknown as T;
  if (typeof value === "string")
    return (isSecretShaped(value) ? mask(value) : value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = KEY_RE.test(key) ? REDACTED_MARKER : redact(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** Line-level scrub for text a surface is about to show (a provider error body, a tool's stderr). */
export function redactText(text: string): string {
  let out = text;
  out = out.replace(/(Authorization\s*:\s*)\S+/gi, `$1${REDACTED_MARKER}`);
  out = out.replace(/([?&](?:key|token|access_token)=)[^\s&]+/gi, `$1${REDACTED_MARKER}`);
  return out.replace(NAME_RE, (m) => mask(m));
}
