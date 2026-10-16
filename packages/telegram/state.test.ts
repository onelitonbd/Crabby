// The state file's contract: 0600, round-trips, and a corrupt file degrades to empty rather than guessing. The sixth
// state-directory name is a recorded decision (DECISIONS.md, the row citing D-078's rule) — this test pins the file's
// behavior, and `docs/DATA_AND_MEMORY.md` §4 carries the same name.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { dataLayout } from "@crabby/platform";
import { EMPTY_STATE, readTelegramState, telegramStatePath, writeTelegramState } from "./state.ts";

const dirs: string[] = [];
function tempLayout() {
  const stateDir = mkdtempSync(join(tmpdir(), "crabby-tg-"));
  dirs.push(stateDir);
  return dataLayout(stateDir);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("telegram.json — D-078's sixth name, 0600", () => {
  it("writes owner-only and reads back the same state", () => {
    const layout = tempLayout();
    writeTelegramState(layout, {
      chats: {
        "100": {
          clientId: "cli_tg1",
          token: "tok",
          pairedAt: "2026-10-16T00:00:00Z",
          userId: "777",
          kind: "private",
          sessionId: "s_1",
        },
      },
      watches: {
        tsk_1: { chatId: "100", messageId: 5, lastSeq: 0, startedAt: "2026-10-16T00:00:00Z" },
      },
      offset: 41,
      shed: undefined,
    });
    const mode = (statSync(telegramStatePath(layout)).mode & 0o777).toString(8);
    assert.equal(
      mode,
      "600",
      "bearer material rides in this file, so the mode is part of the contract",
    );
    const state = readTelegramState(layout);
    assert.equal(state.chats["100"]?.clientId, "cli_tg1");
    assert.equal(state.chats["100"]?.userId, "777");
    assert.equal(state.watches.tsk_1?.messageId, 5);
    assert.equal(state.offset, 41);
  });

  it("a file that does not exist is the empty state, not an error", () => {
    const layout = tempLayout();
    assert.deepEqual(readTelegramState(layout), EMPTY_STATE);
  });

  it("a corrupt file degrades to empty — pairing is a /start away, so nothing is faked", () => {
    const layout = tempLayout();
    writeFileSync(telegramStatePath(layout), "{ this is not json");
    assert.deepEqual(readTelegramState(layout), EMPTY_STATE);
  });

  it("the raw file carries no surprises: one JSON object, newline-terminated", () => {
    const layout = tempLayout();
    writeTelegramState(layout, EMPTY_STATE);
    const raw = readFileSync(telegramStatePath(layout), "utf8");
    assert.match(raw, /\n$/);
    const parsed = JSON.parse(raw) as {
      chats: Record<string, never>;
      watches: Record<string, never>;
    };
    assert.deepEqual(parsed.chats, {});
    assert.deepEqual(parsed.watches, {});
  });
});
