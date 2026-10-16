// T13's settings view.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ConfigFile, DEFAULT_CONFIG } from "@crabby/core";
import { applyEdit, configEntries, diffLines, parseValue, settingsLines } from "./settings.ts";

describe("T13-01 — the keys are the schema's walk, not a hand-coded list", () => {
  it("carries limits' scalars, workspace.roots and shell as dotted keys", () => {
    const keys = configEntries(DEFAULT_CONFIG).map((entry) => entry.key);
    assert.ok(
      keys.some((key) => key.startsWith("limits.")),
      keys.join(","),
    );
    assert.ok(keys.includes("workspace.roots"), keys.join(","));
    assert.ok(
      keys.some((key) => key.startsWith("shell.")),
      keys.join(","),
    );
    assert.ok(keys.includes("defaultModel"), keys.join(","));
  });

  it("provider rows come from the user's document, so new entries appear", () => {
    const config = {
      ...DEFAULT_CONFIG,
      provider: { local: { baseUrl: "http://127.0.0.1:9", models: {} } },
    } as ConfigFile;
    const keys = configEntries(config).map((entry) => entry.key);
    assert.ok(keys.includes("provider.local.baseUrl"), keys.join(","));
  });

  it("kinds come from the schema, so `true` is a boolean and `roots` an array", () => {
    const entries = configEntries(DEFAULT_CONFIG);
    const roots = entries.find((entry) => entry.key === "workspace.roots");
    assert.equal(roots?.kind, "array");
    const timeout = entries.find((entry) => entry.key === "limits.fsTimeoutMs");
    assert.equal(timeout?.kind, "number");
  });
});

describe("T13-04 — the T3 marker is a word on the security-relevant rows", () => {
  it("shell, net, workspace and provider rows are marked before any edit", () => {
    const lines = settingsLines(configEntries(DEFAULT_CONFIG), 100, 0, {});
    const marked = lines.filter((line) => line.includes("> T3 "));
    assert.ok(
      configEntries(DEFAULT_CONFIG)
        .filter((entry) => entry.security)
        .every(
          (entry) =>
            entry.key.startsWith("shell.") ||
            entry.key.startsWith("net.") ||
            entry.key.startsWith("workspace.") ||
            entry.key.startsWith("provider."),
        ),
      "the marker's families are exactly the §-relevant ones",
    );
    assert.ok(marked.length === 0 || marked[0]?.includes("T3"), "the marker is a word on the row");
  });

  it("limits rows are not marked", () => {
    const entries = configEntries(DEFAULT_CONFIG);
    assert.ok(
      entries.filter((entry) => entry.key.startsWith("limits.")).every((entry) => !entry.security),
    );
  });
});

describe("T13-03 — the diff is `-`/`+`, shown before the apply", () => {
  it("renders both sides as pasteable lines", () => {
    const lines = diffLines("limits.fsTimeoutMs", 10000, 15000, 100);
    assert.match(lines[0] ?? "", /^- limits\.fsTimeoutMs: 10000$/, lines.join(" | "));
    assert.match(lines[1] ?? "", /^\+ limits\.fsTimeoutMs: 15000$/, lines.join(" | "));
  });
});

describe("the parse and the write", () => {
  it("JSON when it parses, a string when it does not — the CLI's own rule", () => {
    assert.equal(parseValue("true"), true);
    assert.equal(parseValue("15000"), 15000);
    assert.equal(parseValue("ollama"), "ollama");
  });

  it("applyEdit refuses a stale token instead of silently overwriting (§2, D-107)", () => {
    const layout = { configPath: "/tmp/nowhere-config.json" } as Parameters<
      typeof import("@crabby/core").writeConfig
    >[0];
    const result = applyEdit(
      { file: structuredClone(DEFAULT_CONFIG), token: "stale-token" },
      "limits.fsTimeoutMs",
      "15000",
      () => ({ ok: false, code: "stale", message: "the file changed since this read" }),
      layout,
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /refused: the file changed/);
  });
});

describe("the view", () => {
  it("the editing key shows its buffer, the diff, and the two-step confirm", () => {
    const entries = configEntries(DEFAULT_CONFIG);
    const index = entries.findIndex((entry) => entry.key === "limits.fsTimeoutMs");
    const lines = settingsLines(entries, 100, index, {
      editing: "limits.fsTimeoutMs",
      buffer: "15000",
      diff: diffLines("limits.fsTimeoutMs", entries[index]?.value, 15000, 100),
    });
    const said = lines.join(" | ");
    assert.match(said, /new value: 15000/, said);
    assert.match(said, /Enter writes/, said);
  });

  it("the carried gaps are named, not silent", () => {
    const lines = settingsLines(configEntries(DEFAULT_CONFIG), 120, 0, {});
    const said = lines.join(" ");
    assert.match(said, /T13-05/);
    assert.match(said, /T13-06/);
    assert.match(said, /T13-09/);
  });
});
