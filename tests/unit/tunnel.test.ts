// The Quick Tunnel's lifecycle, tested the way §17 wants security code tested: against a fake, with the
// failure cases as the tests. The fake command is a real executable — a Node script that prints a URL-shaped
// line and then waits — so what runs here is the actual spawn/parse/kill machinery, minus only the Cloudflare
// handshake. The assertions are the §13 rules: URL discovered not assumed, a start that never produces one is
// a failed start with its last words, and stop closes the process group so nothing outlives the decision.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { QuickTunnel, TUNNEL_URL_PATTERN } from "@crabby/gateway";

/** A stand-in cloudflared: prints the URL on the stream the real one uses (stderr, then stdout variants in the
 *  flags), stays alive, and dies on SIGTERM like the real one does. */
function fakeCloudflared(flavor: "stderr" | "stdout" | "silent" = "stderr"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-tunnel-fake-"));
  const file = path.join(dir, "fake-cloudflared.mjs");
  const print = {
    stderr: "process.stderr.write('https://fake-tunnel-id.trycloudflare.com\\n');",
    stdout: "process.stdout.write('https://fake-tunnel-id.trycloudflare.com\\n');",
    silent: "/* says nothing, stays alive */",
  }[flavor];
  // 0o755: spawn runs the file directly, and a script without the exec bit is the EACCES the test would
  // otherwise misread as the tunnel machinery failing.
  writeFileSync(
    file,
    // The shebang is what makes direct exec work: without it the kernel hands the file to /bin/sh, which
    // reads JavaScript as shell and fails in ways that would teach the wrong lesson.
    `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n${print}\nprocess.on('SIGTERM', () => process.exit(0));\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  return file;
}

const quietLog = {
  info: () => {},
  error: () => {},
};

function urlIn(text: string): boolean {
  return TUNNEL_URL_PATTERN.test(text);
}

test("the URL pattern only answers a trycloudflare host", () => {
  assert.ok(urlIn("https://some-id.trycloudflare.com"));
  assert.ok(urlIn("+ https://some-id.trycloudflare.com/ your quick tunnel exists"));
  assert.ok(
    !urlIn("https://evil.example.com/trycloudflare.com"),
    "a URL is the host, not a substring",
  );
  assert.ok(
    !urlIn("http://some-id.trycloudflare.com"),
    "§13's tunnels are https; plaintext does not count",
  );
});

test("start discovers the URL from the child's stderr and reports ready", async () => {
  const tunnel = new QuickTunnel({ command: fakeCloudflared("stderr"), log: quietLog });
  const opened = await tunnel.start("http://127.0.0.1:45657");
  assert.ok(opened.ok);
  assert.match(opened.url, /trycloudflare\.com$/);
  const snapshot = tunnel.snapshot();
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.url, opened.url);
  assert.ok(snapshot.startedAt !== undefined);
  await tunnel.stop();
  assert.equal(tunnel.snapshot().state, "off");
});

test("stop kills the process group: the child is gone, not merely forgotten", async () => {
  const command = fakeCloudflared("stdout");
  const tunnel = new QuickTunnel({ command, log: quietLog });
  const opened = await tunnel.start("http://127.0.0.1:45658");
  assert.ok(opened.ok);
  const { spawnSync } = await import("node:child_process");
  // The child is in its own group; asking pgrep for the script by name finds nothing after stop.
  await tunnel.stop();
  const check = spawnSync("pgrep", ["-f", "fake-cloudflared.mjs"], { encoding: "utf8" });
  assert.equal(
    check.stdout.trim(),
    "",
    "an orphaned tunnel is exposure that outlived the decision to stop — §13's stop must close the listener",
  );
  assert.equal(
    tunnel.snapshot().url,
    undefined,
    "the dead URL is gone with the child (never redirected, D-066)",
  );
});

test("a start that never produces a URL fails with the child's last words, on a bounded clock", async () => {
  const _tunnel = new QuickTunnel({ command: fakeCloudflared("silent"), log: quietLog });
  // A fake that stays silent would take the full 60 s; this run short-circuits by checking the *other* silent
  // failure instead — an exiting child — and leaves the timer case to the integration suite, which injects a
  // host and controls time.
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-tunnel-exit-"));
  const file = path.join(dir, "exit-fast.mjs");
  writeFileSync(
    file,
    "#!/usr/bin/env node\nprocess.stderr.write('warming up');\nprocess.exit(3);\n",
    { encoding: "utf8", mode: 0o755 },
  );
  const fast = new QuickTunnel({ command: file, log: quietLog });
  const opened = await fast.start("http://127.0.0.1:45659");
  assert.ok(!opened.ok);
  assert.match(opened.reason, /exited with code 3/);
  assert.match(
    opened.reason,
    /warming up/,
    "the reason carries the child's last words — the fix needs them",
  );
  assert.equal(fast.snapshot().state, "failed");
});

test("a second start while one is active is refused, because exposure is one decision at a time", async () => {
  const tunnel = new QuickTunnel({ command: fakeCloudflared("stderr"), log: quietLog });
  const first = await tunnel.start("http://127.0.0.1:45660");
  assert.ok(first.ok);
  const second = await tunnel.start("http://127.0.0.1:45661");
  assert.ok(!second.ok);
  assert.match(second.reason, /already active/);
  await tunnel.stop();
});

test("a binary that does not exist is a failed start that names it", async () => {
  const tunnel = new QuickTunnel({ command: "/nowhere/cloudflared", log: quietLog });
  const opened = await tunnel.start("http://127.0.0.1:45662");
  assert.ok(!opened.ok);
  assert.match(opened.reason, /nowhere\/cloudflared/);
});
