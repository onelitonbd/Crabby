// T14's access view.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessLines,
  type ClientRow,
  clientLines,
  mintLines,
  revokeConfirmLines,
} from "./access.ts";

const client = (over: Partial<ClientRow> = {}): ClientRow => ({
  id: "cli_1",
  name: "pixel 8a",
  interface: "cli",
  capabilities: ["session.read", "task.create"],
  createdAt: "2026-10-01T09:00:00Z",
  lastUsedAt: "2026-10-15T22:10:00Z",
  liveStreams: 0,
  ...over,
});

describe("T14-01 — two lines per client, connected as a word", () => {
  it("says `connected` with the stream count when streams are live", () => {
    const [first] = clientLines(client({ liveStreams: 2 }), 40, false);
    assert.match(first ?? "", /connected · 2 streams/, first);
    assert.ok((first ?? "").length <= 40, first);
  });

  it("says `not connected` — a word, never a green dot", () => {
    const [first] = clientLines(client(), 40, false);
    assert.match(first ?? "", /not connected/, first);
  });

  it("the second line carries the capability words and the dates", () => {
    const [, second] = clientLines(client({ capabilities: ["fs.read"] }), 40, false);
    assert.match(second ?? "", /fs\.read/, second);
    assert.match(second ?? "", /seen 10-15/, second);
    assert.match(second ?? "", /made 10-01/, second);
    assert.ok((second ?? "").length <= 40, second);
  });
});

describe("T14-03 — revoke prints what it will end, first", () => {
  it("names the stream count in the confirm, before the act", () => {
    const [line] = revokeConfirmLines(client({ liveStreams: 3 }), false);
    assert.match(line ?? "", /3 streams end/, line);
    assert.match(line ?? "", /r again/, line);
    assert.ok((line ?? "").length <= 40, line);
  });

  it("names zero streams honestly when nothing is live", () => {
    const [line] = revokeConfirmLines(client(), false);
    assert.match(line ?? "", /nothing live/, line);
  });

  it("warns when the identity is this app's own, on its own line", () => {
    const lines = revokeConfirmLines(client({ liveStreams: 1 }), true);
    assert.match(lines[0] ?? "", /1 stream ends/, lines.join(" | "));
    assert.match(lines[1] ?? "", /THIS app speaks as/, lines.join(" | "));
  });
});

describe("T14-02 — the mint answer", () => {
  it("the code sits on its own line, with the granted count beside it", () => {
    const lines = mintLines(
      {
        code: "8241",
        expiresAt: "2026-10-16T10:30:00Z",
        capabilities: ["session.read", "task.create", "task.cancel"],
      },
      "127.0.0.1",
      40,
    );
    assert.ok(
      lines.some((line) => line.trim() === "8241"),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((line) => line.includes("3 granted")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((line) => line.includes("on 127.0.0.1")),
      lines.join(" | "),
    );
    assert.ok(
      lines.every((line) => line.length <= 40),
      lines.join(" | "),
    );
  });
});

describe("the whole view", () => {
  it("shows the listener and its loopback state, and the gaps in words", () => {
    const lines = accessLines([client()], 40, 0, {
      listener: { host: "127.0.0.1", port: 8734 },
    });
    const said = lines.join(" ").replace(/\s+/g, " ");
    assert.match(said, /bind 127\.0\.0\.1:8734 · loopback only/);
    assert.match(said, /T14-04/, "the restrict gap is named, not silent");
    assert.match(said, /T14-06/, "the tunnel gap is named");
    for (const line of lines) assert.ok(line.length <= 40, line);
  });

  it("a non-loopback bind gets the warning that names what becomes reachable", () => {
    const lines = accessLines([], 40, 0, {
      listener: { host: "192.168.0.7", port: 8734 },
    });
    assert.ok(
      lines.some((line) => line.includes("NOT loopback") && line.includes("192.168.0.7")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((line) => line.includes("every device that can reach this host")),
      lines.join(" | "),
    );
  });

  it("an empty list says how to get one", () => {
    const lines = accessLines([], 40, 0, {});
    assert.ok(
      lines.some((line) => line.includes("no paired clients")),
      lines.join(" | "),
    );
  });
});
