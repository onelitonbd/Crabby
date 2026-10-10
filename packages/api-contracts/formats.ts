// TypeBox 0.34 does not ship string formats; a schema that says `format: "date-time"` fails as "unknown format"
// until the format exists. Registering it here, on import of the contracts, is what makes every timestamp in the
// product mean one thing: an RFC 3339 instant in UTC. Offsets are refused on purpose — the documents write `Z`
// everywhere (§5.2), and a contract that accepts both invites a client to compare wall-clock strings.
import { FormatRegistry } from "@sinclair/typebox";

export const DATE_TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$";

let registered = false;
export function ensureFormats(): void {
  if (registered) return;
  FormatRegistry.Set("date-time", (value) => new RegExp(DATE_TIME_PATTERN).test(value));
  registered = true;
}
ensureFormats();
