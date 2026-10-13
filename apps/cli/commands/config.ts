// The `config` noun of `docs/INTERFACES_AND_API.md` §7.1's table — `config get/set/path/schema`. Four verbs, one purpose: the file stays the only
// format, and `crabby config schema --json` prints the schema itself rather than a description of it (D-060's reason
// for choosing TypeBox: "the contract, the config schema and the generated help all need JSON Schema as an output").
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import {
  applyConfigKey,
  type ConfigFile,
  configSchema,
  loadConfig,
  parseConfigValue,
  writeConfig,
} from "@crabby/core";
import type { DataLayout } from "@crabby/platform";
import type { Renderer } from "../output.ts";

export type ConfigVerb = "path" | "get" | "set" | "schema";

export function runConfig(
  verb: ConfigVerb | undefined,
  args: string[],
  layout: DataLayout,
  renderer: Renderer,
): ExitCode {
  const loaded = loadConfig(layout);

  if (verb === undefined || verb === "path") {
    renderer.line("config", loaded.path ?? `${layout.configPath} (does not exist yet)`);
    if (!loaded.exists) renderer.fix("crabby init creates it");
    return renderer.done({ path: layout.configPath, exists: loaded.exists });
  }

  if (verb === "schema") {
    // The schema is printed whether or not `--json` was passed: it *is* JSON, and a human asked to see it.
    if (!renderer.json) renderer.raw(JSON.stringify(configSchema(), null, 2));
    return renderer.done(configSchema());
  }

  if (verb === "get") {
    // Printed as the file says it, with no `configForReading` scrub — and the asymmetry with `GET /api/v1/config` and the
    // `config.get` tool is deliberate rather than an oversight, so it is written down here where a reader meets it. Those
    // two answer *clients*: a browser, a bot, or a model that would quote a value into a provider request, which
    // SECURITY.md §14 forbids and §7 puts on the serializer. This one answers the owner, on the device that holds the
    // file, about a file they own — and in a valid document there is nothing to withhold anyway, because §3.3 refuses an
    // inline key at the keystroke and `provider.<id>.key` is a `vault://` name. The difference is only visible in a file
    // the schema already refuses, and a terminal is exactly where the user goes to look at the value they have to fix:
    // redacting it there would hide the mistake behind a marker.
    const key = args[0];
    const value: unknown = key === undefined ? loaded.config : pick(loaded.config, key);
    if (value === undefined) {
      renderer.line("no such key", String(key));
      renderer.fix("`crabby config schema --json` lists the keys that exist");
      return EXIT.usage;
    }
    if (!renderer.json) {
      if (typeof value === "object" && value !== null) {
        for (const [name, item] of Object.entries(value as Record<string, unknown>))
          renderer.line(name, formatItem(item));
      } else {
        renderer.line(key ?? "config", formatItem(value));
      }
    }
    return renderer.done({ [key ?? "config"]: value });
  }

  // `set`
  const [key, raw] = args;
  if (key === undefined || raw === undefined) {
    renderer.line("usage", "crabby config set <dotted.key> <value>");
    renderer.fix(
      "values are JSON when they parse, otherwise strings: `config set limits.fsTimeoutMs 15000`",
    );
    return EXIT.usage;
  }
  // Written from `loaded.file`, not `loaded.config`: the file holds overrides, and a `set` that round-tripped the
  // merged view would freeze today's defaults into the user's config forever.
  const next = applyConfigKey(loaded.file, key, parseConfigValue(raw));
  // The token this command read, presented back: §2's concurrency row is about two interfaces editing one configuration,
  // and a terminal is one of them — a Gateway `PUT /config` that landed between the read above and the write below is
  // exactly the silent overwrite the row exists to refuse. It is a compare-and-swap and not a lock, because a file has no
  // isolation level to be (D-107).
  const written = writeConfig(layout, next as ConfigFile, undefined, { token: loaded.token });
  if (!written.ok) {
    renderer.line("refused", `config ${written.message}`);
    renderer.fix(
      written.code === "stale"
        ? "the file changed since this command read it — run `crabby config get` again and write once more"
        : "the file was not changed",
    );
    return EXIT.usage;
  }
  renderer.line("wrote", layout.configPath);
  return renderer.done({
    key,
    value: parseConfigValue(raw),
    path: layout.configPath,
    ...(written.token === undefined ? {} : { token: written.token }),
  });
}

function pick(config: Record<string, unknown>, dotted: string): unknown {
  let cursor: unknown = config;
  for (const segment of dotted.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function formatItem(item: unknown): string {
  return typeof item === "object" && item !== null ? JSON.stringify(item) : String(item);
}
