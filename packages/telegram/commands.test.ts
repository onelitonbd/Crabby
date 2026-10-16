// Region G3's grammar and G-O's first-run strings, held as data. The parity checker reads the same COMMANDS table
// from `scripts/parity.ts`'s other side — these tests hold the rows' behavior, not their existence (that is parity's
// job), and G3-28's "the row count is the source" is a property the two directions agree on.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOT_ABOUT,
  COMMANDS,
  closestCommand,
  FIRST_RUN_CARD,
  helpText,
  menuCommands,
  parseCommand,
} from "./commands.ts";
import { MENU_MAX } from "./limit.ts";

describe("the command table (G3, one command per parity-matrix capability)", () => {
  it("every command has a one-line about, and /help renders from the same table (G3-28)", () => {
    for (const command of COMMANDS) {
      assert.ok(command.about.length > 0, `${command.name} has no about line`);
      assert.ok(!command.about.includes("\n"), `${command.name}'s about is not one line`);
      assert.match(command.about, /G3-\d+|G7-\d+|G6-\d+/, `${command.name}'s about names its row`);
    }
    const help = helpText();
    for (const command of COMMANDS) {
      assert.ok(help.includes(command.about), `/help is missing ${command.name}`);
    }
  });

  it("the refusals name their owning row — the documented limitations are visible in this interface (G3-31)", () => {
    for (const name of ["pair", "auth", "restart", "shutdown"]) {
      const command = COMMANDS.find((candidate) => candidate.name === name);
      assert.ok(command?.refused !== undefined, `${name} is a refusal row`);
      assert.match(
        command.refused.reason,
        /D-053|G7-03|G7-08/,
        `${name}'s refusal names the decision`,
      );
    }
  });

  it("the menu is at most Telegram's ten (G-O04), never a refused command", () => {
    const menu = menuCommands();
    assert.ok(menu.length <= MENU_MAX);
    assert.ok(
      menu.length >= 5,
      "a five-command menu for thirty-three rows would be curation, not choice",
    );
    for (const entry of menu) {
      const command = COMMANDS.find((candidate) => `/${candidate.name}` === entry.command);
      assert.ok(
        command !== undefined && command.refused === undefined,
        `${entry.command} must not be a refused row`,
      );
    }
  });

  it("the first-run card is the invite, ≤5 lines, ending in the /help pointer (G-O03)", () => {
    const lines = FIRST_RUN_CARD.split("\n");
    assert.ok(lines.length <= 5);
    assert.match(FIRST_RUN_CARD, /→ \/help$/);
  });

  it("the about text is one sentence, no version promise, no security detail (G-O05)", () => {
    assert.ok(BOT_ABOUT.length <= 256);
    assert.doesNotMatch(BOT_ABOUT, /token|vault|allow|secret|version \d/i);
    assert.ok(!BOT_ABOUT.includes("\n"));
  });
});

describe("parseCommand (G1-06/G1-07's grammar half)", () => {
  it("a command is a leading slash; args ride after one space", () => {
    assert.deepEqual(parseCommand("/ask what is up"), {
      name: "ask",
      args: "what is up",
      addressed: false,
    });
    assert.deepEqual(parseCommand("/tasks"), { name: "tasks", args: "", addressed: false });
  });

  it("a group command may address the bot; another bot's address is not ours", () => {
    const ours = parseCommand("/tasks@crabby_bot", "crabby_bot");
    assert.equal(ours?.name, "tasks");
    assert.equal(ours?.addressed, true);
    assert.equal(parseCommand("/tasks@other_bot", "crabby_bot"), undefined);
  });

  it("a mention inside someone else's sentence is not a command (G1-07)", () => {
    assert.equal(parseCommand("hey everyone /tasks is great"), undefined);
    assert.equal(parseCommand("no slash at all"), undefined);
    assert.equal(parseCommand("see /home directory"), undefined);
  });

  it("case-insensitive name, preserved args", () => {
    assert.equal(parseCommand("/TASKS one two")?.name, "tasks");
    assert.equal(parseCommand("/Ask What Is Up")?.args, "What Is Up");
  });
});

describe("closestCommand (G3-29 — the one place silence is not allowed)", () => {
  it("a typo names the nearest real command", () => {
    assert.equal(closestCommand("tasls"), "tasks");
    assert.equal(closestCommand("helo"), "help");
    assert.equal(closestCommand("cencel"), "cancel");
  });

  it("a distant word names nothing — inventing a near-miss would be its own lie", () => {
    assert.equal(closestCommand("zzzzzzzz"), undefined);
  });
});
