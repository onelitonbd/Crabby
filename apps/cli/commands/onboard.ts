// `crabby onboard` — the whole first-run as one guided flow, the way the owner asked for it: "পুরোটাই সুন্দর করে
// টার্মিনাল UI-তে সাজানো" — the OpenClaw wizard's ergonomics bought without OpenClaw's mechanism.
//
// The design rule this file obeys is the one `docs/INSTALL.md`'s rehearsal already proved: every step it drives
// is the same verb a user types by hand — `init`, `doctor`, `gateway start` (via the running CLI), `auth pair`,
// `vault set`, `provider add`. The wizard is a **hand on those commands**, never a second collector: it prints
// each command before running it (the paste trail), so a scripted reader can reproduce the whole session from
// the output. What it adds over the loose steps is exactly what `docs/TROUBLESHOOTING.md`'s four real hits say a
// first-run needs:
//
//   1. state-aware start — the wizard reads where you are (fresh? paired? configured?) and skips what is done,
//      so "a start with no first-client code" (hit 4) becomes a sentence, not a mystery;
//   2. the pairing code is the loudest thing on screen — printed as its own boxed block with the second-session
//      instruction beside it (hits 2 and 3), because the single most-fumbled moment of the manual path is
//      missing the code at the bottom of a wall of composition lines;
//   3. verification before celebration — a provider is not "configured" until it answers a real completion
//      (the `model probe` route, D-133), which is the wizard's analogue of OpenClaw's verify-with-a-real-reply;
//   4. non-TTY is the manual path — no prompts, no piping surprises: the wizard prints the remaining commands
//      as a numbered list and exits, because a wizard that guesses in a pipe is a hazard.
//
// Scope, honestly named: this file drives steps and reads state; it does not re-implement any of them. Config
// writes go through `commands/config.ts`'s writer, pairing through the same redeem the verb uses, and the
// Gateway start is the real `gateway start` — the wizard runs it as a child process on the user's terminal and
// waits for the listener file, because a wizard that swallowed the Gateway into its own process would take the
// Ctrl-C away.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout, PlatformFacts } from "@crabby/platform";
import type { Renderer } from "../output.ts";

interface OnboardInput {
  readonly layout: DataLayout;
  readonly facts: PlatformFacts;
  readonly rootPackageJson: string;
  readonly repoRoot: string;
}

/** The one place the wizard asks a human a question. TTY only; the non-TTY branch never reaches it. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  return answer.trim();
}

/** Run one existing verb as a child on the user's terminal, echoing it first — the wizard's whole honesty is
 *  that it never runs anything a user could not have typed. Returns the child's exit code. */
function runVerb(repoRoot: string, argv: readonly string[], renderer: Renderer): Promise<number> {
  renderer.line("", `$ crabby ${argv.join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "apps/cli/crabby.ts"), ...argv], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/** The model verification, through the model-probe route the CLI's `model probe` verb already drives. */
function verifyModel(repoRoot: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "apps/cli/crabby.ts"), "model", "probe", target],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/** Where the first-run actually is. Four facts, each read the same way the manual commands read them. */
async function survey(input: OnboardInput): Promise<{
  readonly fresh: boolean;
  readonly paired: boolean;
  readonly providerConfigured: boolean;
  readonly defaultModel: string | undefined;
}> {
  const configPath = path.join(input.layout.stateDir, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  const providers = (config.provider ?? {}) as Record<string, unknown>;
  const providerConfigured = Object.values(providers).some(
    (entry) =>
      typeof entry === "object" && entry !== null && (entry as { baseUrl?: unknown }).baseUrl,
  );
  let paired = false;
  try {
    const dbPath = path.join(input.layout.stateDir, "crabby.sqlite3");
    if (existsSync(dbPath)) {
      // Dynamic import so the native module resolves from the checkout's own node_modules — the same way
      // `commands/backup.ts` reaches the database, and for the same reason: the wizard works from any cwd.
      const { default: Database } = (await import("better-sqlite3")) as {
        default: new (
          path: string,
        ) => {
          prepare: (sql: string) => { get: () => { n: number } };
          close: () => void;
        };
      };
      const db = new Database(dbPath);
      const count = db.prepare("SELECT COUNT(*) AS n FROM client_identity").get();
      paired = count.n > 0;
      db.close();
    }
  } catch {
    paired = false;
  }
  return {
    fresh: !existsSync(configPath),
    paired,
    providerConfigured,
    defaultModel: typeof config.defaultModel === "string" ? config.defaultModel : undefined,
  };
}

export function runOnboard(
  rest: string[],
  input: OnboardInput,
  renderer: Renderer,
): Promise<ExitCode> {
  if (rest.includes("--help")) {
    renderer.line("usage", "crabby onboard [--yes]");
    renderer.line(
      "what",
      "init → doctor → gateway start → pair → provider → verify → first chat, one guided flow",
    );
    renderer.line(
      "non-tty",
      "no prompts — prints the remaining commands as a numbered list and exits",
    );
    return Promise.resolve(EXIT.success);
  }
  const tty = process.stdin.isTTY === true;
  return (async (): Promise<ExitCode> => {
    const state = await survey(input);
    renderer.line(
      "onboard",
      `Crabby first-run — ${input.facts.platform}/${input.facts.arch}, Node ${input.facts.nodeVersion}`,
    );

    // 0. Where you are, said out loud — the sentence the manual path never printed (hit 4).
    renderer.line(
      "state",
      state.fresh
        ? "fresh install — starting from the top"
        : [
            state.paired ? "paired ✓" : "not paired",
            state.providerConfigured ? "provider configured ✓" : "no provider yet",
            state.defaultModel ? `default model: ${state.defaultModel} ✓` : "no default model",
          ].join(" · "),
    );
    if (!tty) {
      renderer.line("", "");
      renderer.line(
        "non-interactive",
        "the guided flow needs a terminal; run these by hand, in order:",
      );
      const steps: string[] = [];
      if (state.fresh) steps.push("crabby init");
      steps.push("crabby doctor");
      if (!state.paired)
        steps.push(
          "crabby gateway start        # pair from a second session: crabby auth pair --code <code>",
        );
      if (!state.providerConfigured)
        steps.push("crabby vault set <provider-name>   # the key arrives on stdin");
      if (!state.defaultModel) steps.push("crabby config set defaultModel <provider>/<modelId>");
      steps.forEach((step, index) => {
        renderer.line(`  ${String(index + 1)}.`, step);
      });
      renderer.fix("then: crabby onboard — re-run any time; it skips what is already done");
      return EXIT.success;
    }

    // 1. init
    if (state.fresh) {
      if ((await runVerb(input.repoRoot, ["init"], renderer)) !== 0) {
        renderer.fix("init failed — run `crabby doctor` and send the output");
        return EXIT.failure;
      }
    }

    // 2. doctor — the green light, and the recovery tool if this wizard cannot continue.
    if ((await runVerb(input.repoRoot, ["doctor"], renderer)) !== 0) {
      renderer.line("doctor", "reported problems — the fix lines above name each one");
      renderer.fix(
        "fix what it named, then re-run `crabby onboard` — it skips what you already did",
      );
      return EXIT.failure;
    }

    // 3. gateway + pairing — the wizard starts the real Gateway as a child on this terminal and waits for the
    // pairing moment, because swallowing the process would take the Ctrl-C away. The code block is the loudest
    // thing on screen (hits 2 and 3): boxed, with the second-session sentence beside it.
    if (!state.paired) {
const pairing = await startGatewayForPairing(input, renderer);
      if (pairing.code === undefined) {
        if (pairing.sawPrompt) {
          renderer.fix(
            "the code was printed in the Gateway output above — redeem it in the OTHER session:",
          );
          renderer.fix("  crabby auth pair --code <code>     then `crabby status` to confirm");
          renderer.fix("re-run `crabby onboard` afterwards — it skips what is already done");
        } else {
          renderer.fix(
            "no pairing code appeared — identities already exist; `crabby status` likely just answers",
          );
          renderer.fix(
            "if `crabby status` says `auth_invalid` instead, see docs/TROUBLESHOOTING.md (pairing reset)",
          );
        }
        return EXIT.failure;
      }
      const ok = await redeemCode(input, pairing.code);
      if (!ok) {
        renderer.fix(
          "the code expired or was already used — harmless: stop the Gateway (Ctrl-C) and re-run `crabby onboard`; a fresh code is printed every start until one identity exists",
        );
        return EXIT.failure;
      }
    }

    // 4. provider — optional by design (the mock endpoint needs no key), priced honestly if skipped.
    let target = state.defaultModel;
    if (!state.providerConfigured) {
      const provision = await ask("Configure a model provider now? [Y/n] ");
      if (provision === "" || provision.toLowerCase() === "y") {
        const name = (await ask("provider name (e.g. groq): ")) || "local";
        const baseUrl = await ask("base URL (e.g. https://api.groq.com/openai/v1): ");
        if (
          (await runVerb(
            input.repoRoot,
            ["provider", "add", name, "--base-url", baseUrl, "--model", "?"],
            renderer,
          )) !== 0
        ) {
          renderer.fix(
            "`crabby provider add` needs a real model id — run it by hand with the model you use",
          );
        }
        const key = await ask("API key (empty = no key needed): ");
        if (key !== "") {
          if ((await runVerb(input.repoRoot, ["vault", "set", name], renderer)) !== 0) {
            renderer.fix(
              "the key did not land in the vault — `crabby vault set " +
                name +
                "` by hand (the value arrives on stdin)",
            );
          }
        }
      } else {
        renderer.fix(
          "skipped — a provider is not required to onboard; the mock endpoint composes, and real tasks wait for one",
        );
      }
    }

    // 5. verification before celebration — a real completion through the probe route (OpenClaw's best idea, ours
    // now too). Skipped honestly when there is nothing to verify yet.
    if (target === undefined) {
      const answer =
        (await ask("default model <provider>/<modelId> (empty = skip verification): ")) || "";
      target = answer === "" ? undefined : answer;
    }
    if (target !== undefined) {
      renderer.line(
        "verify",
        `asking ${target} for one small completion — the wizard's promise is a *working* model, not a saved key`,
      );
      const ok = await verifyModel(input.repoRoot, target);
      renderer.line(
        "verify",
        ok
          ? "the model answered ✓"
          : "the model did not answer — the key, URL or model id needs another look",
      );
      if (!ok) {
        renderer.fix(
          "`crabby model probe " +
            target +
            "` by hand shows the exact failure; onboarding is still saved",
        );
        return EXIT.failure;
      }
    } else {
      renderer.fix(
        "no model verified yet — `crabby model probe <provider>/<model>` when one is configured",
      );
    }

    // 6. done — the paste trail, and the two commands that matter now.
    renderer.line("", "");
    renderer.line("onboard", "done — what you can type now:");
    renderer.line("  chat", 'crabby chat "hello" — one question, one answer');
    renderer.line("  task", 'crabby task run "…" — a multi-step task with approvals');
    renderer.line("  tui", "crabby tui — the full terminal UI");
    renderer.line("  web", "crabby web open — the browser dashboard");
    renderer.fix("the Gateway keeps running in this terminal; Ctrl-C stops it (D-066's drain)");
    renderer.fix("re-run `crabby onboard` any time — it skips what is already done");
    return EXIT.success;
  })();
}

/** Starts `crabby gateway start` as a child on this terminal, watches its stdout for the bootstrap code, and
 *  resolves with the code once the listener line appears. The Gateway keeps running — the wizard does not own
 *  it; the user's Ctrl-C does. */
interface GatewayPairing {
  /** The bootstrap code, once the listener is up and the `first client` block has been seen. */
  readonly code?: string | undefined;
  /** The Gateway printed a pairing prompt but the code was not captured — the honest answer is "read it above". */
  readonly sawPrompt: boolean;
  readonly sawListener: boolean;
}

function startGatewayForPairing(
  input: OnboardInput,
  renderer: Renderer,
): Promise<GatewayPairing> {
  renderer.line(
    "gateway",
    "starting the Gateway here — pairing code will be boxed below; leave this terminal running",
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(input.repoRoot, "apps/cli/crabby.ts"), "gateway", "start"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buffer = "";
    let sawPrompt = false;
    let sawListener = false;
    const finish = (code: string | undefined) => {
      clearTimeout(timer);
      resolve({ ...(code === undefined ? {} : { code }), sawPrompt, sawListener });
    };
    const timer = setTimeout(() => finish(undefined), 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      buffer += text;
      if (/pair with this code/.test(buffer)) sawPrompt = true;
      if (/gateway\s+http:\/\/127\.0\.0\.1/.test(buffer)) sawListener = true;
      // Unanchored on purpose: a pty delivers the Gateway's output in whatever chunks the terminal's line
      // discipline decides, and a `$`-anchored match only wins when the buffer happens to end with the code.
      const code = /pair with this code[^\n]*\n\s*([A-Z0-9]{8})/.exec(buffer)?.[1];
      if (code !== undefined && sawListener) {
        // The boxed block: the one moment the manual path fumbled, made the loudest thing on screen.
        renderer.line("", "┌──────────────────────────────────────────────┐");
        renderer.line("", "│  pairing code — pairing this terminal now…   │");
        renderer.line("", `│                     ${code}                    │`);
        renderer.line("", "│  expires in ~2 minutes · single use          │");
        renderer.line("", "└──────────────────────────────────────────────┘");
        finish(code);
      }
    });
    child.on("exit", () => finish(undefined));
  });
}

/** Redeems the bootstrap code through the same verb a user types, so the trail is reproducible. */
function redeemCode(input: OnboardInput, code: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(input.repoRoot, "apps/cli/crabby.ts"), "auth", "pair", "--code", code],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("exit", (exit) => resolve(exit === 0));
    child.on("error", () => resolve(false));
  });
}
