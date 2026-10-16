// The one rule every screen in this directory inherits, and the reason this file exists before any screen does:
// **interpolation is escaping, by construction.** Every value that reaches the DOM goes through `html`'s tagged
// template, which escapes everything interpolated into it; the only way to emit markup from a value is to pass it
// through `unsafe` — an explicit, greppable admission. `docs/UI_UX_SPEC.md` §4's promise ("refuse rather than redact
// after the fact") is the browser-side twin of the stored-record redaction: model output, tool args, error text and
// titles are *data*, and a transcript that executes a quoted filename is the XSS this file makes unexpressible.
//
// No build step (D-068), so this is plain JS consumed by the browser directly — and by `node --test`, which is why
// the module imports nothing and touches no `window`.

/** Escape a value for safe interpolation into an HTML text position or attribute. */
export function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The one escape hatch, named so a review can find every use. Takes trusted markup **this code wrote** — never a
 *  server field, never model output — and marks it as already-HTML. */
export function unsafe(markup) {
  return { __crabbyUnsafe: markup };
}

/** The template: interpolated values are escaped, `unsafe`-marked values pass through, arrays flatten. */
export function html(strings, ...values) {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += interpolate(values[i]);
  }
  return new SafeString(out);
}

/** The template's own product. A nested `html` call's result must pass through an outer template *unescaped* — it is
 *  this module's output, not data — so templates compose the way functions do. A plain string is data and escapes. */
export class SafeString {
  constructor(markup) {
    this.markup = markup;
  }
  toString() {
    return this.markup;
  }
  valueOf() {
    return this.markup;
  }
}

function interpolate(value) {
  if (value === undefined || value === null) return "";
  if (value instanceof SafeString) return value.markup;
  if (typeof value === "object" && "__crabbyUnsafe" in value) return value.__crabbyUnsafe;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return esc(value);
}
