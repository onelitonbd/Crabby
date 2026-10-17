// §13's Quick Tunnel, as a child process. Cloudflare's `cloudflared tunnel --url <target>` is the whole
// mechanism: one command, an ephemeral `*.trycloudflare.com` URL on stdout/stderr, reachability without an
// account — and §13's rules are what this file enforces around it:
//
//   - the URL is discovered, never assumed (D-066: it changes on every start, the Gateway prints the new one,
//     and nothing ever redirects the old one);
//   - a tunnel that never produces a URL is a *failed* start with the reason, not a hanging promise;
//   - `stop` closes the listener for real — the child is spawned in its own process group and the group is
//     signalled, because an orphaned cloudflared is exposure that outlived the decision to stop (§13's "must
//     fully revoke exposure"), with D-066's 5 s drain before the final kill.
//
// The command is `cloudflared` from PATH, or `CRABBY_TUNNEL_COMMAND` when the binary lives somewhere else.
// Tests inject a fake command (a script that prints a URL-shaped line and waits), which is also how the
// integration suite runs this without an internet egress.

import { type ChildProcess, spawn } from "node:child_process";

export const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** The time a start may take to produce a URL before it is a failure — §12's spirit (no forever-pending state)
 *  with the number LIMITS prices for one slow first token (60 s, D-074): a tunnel's first connect is the same
 *  class of wait, a third-party handshake this device does not control. */
export const TUNNEL_READY_MS = 60_000;

/** D-066's drain: SIGTERM first, this long, then SIGKILL — a tunnel that stops on a signal dies clean, and one
 *  that does not is killed rather than left listening. */
export const TUNNEL_DRAIN_MS = 5_000;

export interface TunnelSnapshot {
  readonly state: "off" | "starting" | "ready" | "failed";
  readonly url?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly error?: string | undefined;
  readonly command: string;
}

export class QuickTunnel {
  #child: ChildProcess | undefined;
  #state: TunnelSnapshot["state"] = "off";
  #url: string | undefined;
  #startedAt: string | undefined;
  #error: string | undefined;
  #tail = "";
  readonly #command: string;
  readonly #log: {
    info(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };

  constructor(input: {
    command?: string | undefined;
    log: {
      info(message: string, meta?: Record<string, unknown>): void;
      error(message: string, meta?: Record<string, unknown>): void;
    };
  }) {
    this.#command = input.command ?? process.env.CRABBY_TUNNEL_COMMAND ?? "cloudflared";
    this.#log = input.log;
  }

  get command(): string {
    return this.#command;
  }

  snapshot(): TunnelSnapshot {
    return {
      state: this.#state,
      ...(this.#url === undefined ? {} : { url: this.#url }),
      ...(this.#startedAt === undefined ? {} : { startedAt: this.#startedAt }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
      command: this.#command,
    };
  }

  /** §13: "URL changes on restart, so clients must discover rather than assume" — every start is a fresh
   *  child, a fresh URL, and a snapshot that says `starting` until the line arrives. */
  start(target: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
    if (this.#state === "starting" || this.#state === "ready") {
      return Promise.resolve({
        ok: false,
        reason:
          this.#state === "ready"
            ? `a tunnel is already active (${this.#url}) — DELETE /api/v1/tunnel stops it before another starts`
            : "a tunnel is still starting — DELETE /api/v1/tunnel cancels it",
      });
    }
    this.#url = undefined;
    this.#error = undefined;
    this.#tail = "";
    this.#state = "starting";
    this.#startedAt = new Date().toISOString();
    return new Promise((resolve) => {
      // Its own process group: `stop` signals the group, so cloudflared's own children (it spawns none today,
      // but §9's rule is not about today) go with it instead of becoming orphaned exposure.
      let child: ChildProcess;
      try {
        child = spawn(this.#command, ["tunnel", "--url", target, "--no-autoupdate"], {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        this.#state = "failed";
        this.#error = error instanceof Error ? error.message : String(error);
        resolve({ ok: false, reason: `\`${this.#command}\` could not start: ${this.#error}` });
        return;
      }
      this.#child = child;
      const timer = setTimeout(() => {
        if (this.#state === "starting") {
          this.#state = "failed";
          this.#error = `no URL arrived within ${String(TUNNEL_READY_MS / 1000)}s`;
          void this.#kill();
          resolve({
            ok: false,
            reason:
              `${this.#command} produced no tunnel URL within ${String(TUNNEL_READY_MS / 1000)}s — ` +
              `is it installed and is the network up? (its last words: ${this.#tail.trim() || "none"})`,
          });
        }
      }, TUNNEL_READY_MS);
      const onLine = (chunk: string) => {
        this.#tail = `${this.#tail}${chunk}`.slice(-2000);
        const found = TUNNEL_URL_PATTERN.exec(this.#tail);
        if (found !== null && this.#state === "starting") {
          this.#state = "ready";
          this.#url = found[0];
          clearTimeout(timer);
          this.#log.info("tunnel ready", { url: this.#url });
          resolve({ ok: true, url: this.#url });
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => onLine(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => onLine(chunk.toString()));
      child.once("error", (error) => {
        clearTimeout(timer);
        if (this.#state === "starting") {
          this.#state = "failed";
          this.#error = error.message;
          resolve({ ok: false, reason: `\`${this.#command}\` could not run: ${error.message}` });
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (this.#state === "starting") {
          this.#state = "failed";
          this.#error = `exited with code ${String(code)} before producing a URL`;
          resolve({
            ok: false,
            reason:
              `${this.#command} exited with code ${String(code)} before producing a URL ` +
              `(its last words: ${this.#tail.trim() || "none"})`,
          });
        } else {
          // A ready (or stopping) tunnel whose child died: the state is the truth, and the url is gone with it.
          this.#state = this.#state === "ready" ? "failed" : "off";
          if (this.#state === "failed") this.#error = "the tunnel process exited";
          this.#url = undefined;
          this.#log.error("tunnel process exited", { code });
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.#child === undefined) {
      this.#state = "off";
      this.#url = undefined;
      return;
    }
    await this.#kill();
    this.#state = "off";
    this.#url = undefined;
    this.#log.info("tunnel stopped");
  }

  #kill(): Promise<void> {
    const child = this.#child;
    const pid = child?.pid;
    if (child === undefined || pid === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      try {
        // Negative pid = the process group (the child was spawned detached), so nothing is left listening.
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const force = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, TUNNEL_DRAIN_MS);
      child.once("exit", () => clearTimeout(force));
      // A child that ignores everything still cannot hold this route forever (§12).
      setTimeout(() => {
        clearTimeout(force);
        done();
      }, TUNNEL_DRAIN_MS + 1_000);
    });
  }
}
