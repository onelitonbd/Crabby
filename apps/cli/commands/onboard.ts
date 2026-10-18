// `crabby onboard` — `docs/UI_UX_SPEC.md` §5's First-Run Experience, which that section specifies "like a screen,
// not a README" and which no interface ran until this file: environment → model path → workspace → shell →
// pairing → first task, in §5's order, as one guided flow.
//
// Three rules the screen obeys, each inherited rather than invented:
//
//   - **§6's output rule:** colour is what a TTY gets, never what a pipe receives (`onboard-ui.ts`'s palette makes
//     branching impossible). Non-TTY prints the numbered manual path and exits — a wizard that prompts into a
//     pipe is a hazard, not a convenience.
//   - **The paste trail:** every driven step is the same verb a user types by hand, echoed as `$ crabby …` before
//     it runs. The wizard is a hand on the commands, never a second collector — a scripted reader can reproduce
//     the whole session from the output, and nothing happens that could not have been typed.
//   - **§5's honesty line:** every security-bearing choice names its consequence in one sentence — the shell
//     screen says exactly what enabling means ("not a sandbox" is §5's own sentence), and the wizard's promise is
//     a *verified* model (one real completion through the probe route), never a saved key.
//
// The four real owner-device hits (docs/TROUBLESHOOTING.md) are the reason the flow looks like it does: state is
// spoken before anything runs (hit 4), the pairing code is the loudest block on screen (hits 2 and 3), and a
// re-run skips what is done instead of re-asking it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout, PlatformFacts } from "@crabby/platform";
import {
  banner,
  colorEnabled,
  type MenuOption,
  palette,
  pick,
  rail,
  type StepState,
} from "../onboard-ui.ts";
import type { Renderer } from "../output.ts";

export interface OnboardInput {
  readonly layout: DataLayout;
  readonly facts: PlatformFacts;
  readonly rootPackageJson: string;
  readonly repoRoot: string;
}

const STEP_NAMES = [
  "environment",
  "model path",
  "workspace",
  "shell",
  "pairing",
  "first chat",
] as const;

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  return answer.trim();
}

/** One existing verb, as a child on the user's terminal, echoed first — the paste trail. */
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

function verifyModel(repoRoot: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "apps/cli/crabby.ts"), "model", "probe", target],
      {
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/** Where the first-run actually is — each fact read the same way the manual commands read it. */
async function survey(input: OnboardInput): Promise<{
  readonly fresh: boolean;
  readonly paired: boolean;
  readonly providerConfigured: boolean;
  readonly defaultModel: string | undefined;
  readonly shellDecided: boolean;
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
  const shell = (config.shell ?? {}) as { enabled?: unknown };
  return {
    fresh: !existsSync(configPath),
    paired,
    providerConfigured,
    defaultModel: typeof config.defaultModel === "string" ? config.defaultModel : undefined,
    shellDecided: typeof shell.enabled === "boolean",
  };
}

interface GatewayPairing {
  readonly code?: string | undefined;
  readonly sawPrompt: boolean;
  readonly sawListener: boolean;
}

function startGatewayForPairing(input: OnboardInput, renderer: Renderer): Promise<GatewayPairing> {
  renderer.line(
    "gateway",
    "starting the Gateway here — pairing code will be boxed below; leave this terminal running",
  );
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(input.repoRoot, "apps/cli/crabby.ts"), "gateway", "start"],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
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
      // Unanchored on purpose: a pty delivers the Gateway's output in whatever chunks the terminal decides, and a
      // `$`-anchored match only wins when the buffer happens to end with the code.
      const code = /pair with this code[^\n]*\n\s*([A-Z0-9]{8})/.exec(buffer)?.[1];
      if (code !== undefined && sawListener) {
        const p = palette(colorEnabled(process.stdout));
        renderer.line("", "");
        renderer.line("", p.cyan("┌──────────────────────────────────────────────┐"));
        renderer.line(
          "",
          p.cyan("│") + p.bold("  pairing code — pairing this terminal now…   ") + p.cyan("│"),
        );
        renderer.line(
          "",
          p.cyan(`│                   ${p.green(p.bold(code))}                   │`),
        );
        renderer.line(
          "",
          p.cyan("│") + p.dim("  expires in ~2 minutes · single use          ") + p.cyan("│"),
        );
        renderer.line("", p.cyan("└──────────────────────────────────────────────┘"));
        finish(code);
      }
    });
    child.on("exit", () => finish(undefined));
  });
}

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

/** One arrow-key question. The result keeps Escape separate from an Enter'd row on purpose: Escape is "ask me
 *  later" (nothing is recorded), while an Enter'd safe option is a decision the config remembers. */
async function choose(
  title: string,
  options: readonly MenuOption[],
  p: ReturnType<typeof palette>,
): Promise<{ index: number; cancelled: boolean }> {
  const result = await pick(title, options, p);
  return { index: result.index, cancelled: result.cancelled };
}

export function runOnboard(
  rest: string[],
  input: OnboardInput,
  renderer: Renderer,
): Promise<ExitCode> {
  if (rest.includes("--help")) {
    renderer.line("usage", "crabby onboard");
    renderer.line(
      "what",
      "environment → model path → workspace → shell → pairing → first chat (UI_UX_SPEC §5)",
    );
    renderer.line(
      "non-tty",
      "no prompts — prints the remaining commands as a numbered list and exits",
    );
    return Promise.resolve(EXIT.success);
  }
  return (async (): Promise<ExitCode> => {
    const color = colorEnabled(process.stdout);
    const p = palette(color);
    const tty = process.stdin.isTTY === true;
    const state = await survey(input);
    const statuses: Record<(typeof STEP_NAMES)[number], StepState> = {
      environment: "pending",
      "model path": "pending",
      workspace: "pending",
      shell: "pending",
      pairing: "pending",
      "first chat": "pending",
    };

    if (!tty) {
      // §6: a pipe gets the manual path, numbered, never a prompt.
      renderer.line(
        "onboard",
        `Crabby first-run — ${input.facts.platform}/${input.facts.arch}, Node ${input.facts.nodeVersion}`,
      );
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
      renderer.line("", "");
      renderer.line(
        "non-interactive",
        "the guided flow needs a terminal; run these by hand, in order:",
      );
      const steps: string[] = [];
      if (state.fresh) steps.push("crabby init");
      steps.push("crabby doctor");
      if (!state.providerConfigured) {
        steps.push("crabby provider add <name> --base-url <url> --model <model-id>");
        steps.push("crabby vault set <name>   # the key arrives on stdin");
        steps.push("crabby config set defaultModel <name>/<model-id>");
      }
      if (!state.paired) {
        steps.push(
          "crabby gateway start        # pair from a second session: crabby auth pair --code <code>",
        );
      }
      if (state.defaultModel !== undefined)
        steps.push("crabby model probe <name>/<model-id>   # verify it answers");
      steps.forEach((step, index) => {
        renderer.line(`  ${String(index + 1)}.`, step);
      });
      renderer.fix("then: crabby onboard — re-run any time; it skips what is already done");
      return EXIT.success;
    }

    // The screen: banner, then the rail — redrawn in place as phases complete.
    for (const line of banner(p)) renderer.line("", line);
    renderer.line("", "");
    const drawRail = (): void => {
      for (const line of rail(
        STEP_NAMES.map((name) => ({ name, state: statuses[name] })),
        p,
      )) {
        renderer.line("", line);
      }
    };
    drawRail();
    const setStep = (name: (typeof STEP_NAMES)[number], value: StepState): void => {
      statuses[name] = value;
      const lines = rail(
        STEP_NAMES.map((step) => ({ name: step, state: statuses[step] })),
        p,
      ).length;
      process.stdout.write(`\x1b[${String(lines)}A\x1b[J`);
      drawRail();
    };
    const stepDone = (name: (typeof STEP_NAMES)[number]): void => setStep(name, "done");
    const stepNow = (name: (typeof STEP_NAMES)[number]): void => setStep(name, "now");
    renderer.line("", "");

    // ── §5 step 1: environment ──────────────────────────────────────────────
    stepNow("environment");
    if (state.fresh) {
      if ((await runVerb(input.repoRoot, ["init"], renderer)) !== 0) {
        statuses.environment = "failed";
        renderer.fix("init failed — run `crabby doctor` and send the output");
        return EXIT.failure;
      }
    }
    if ((await runVerb(input.repoRoot, ["doctor"], renderer)) !== 0) {
      statuses.environment = "failed";
      renderer.line("doctor", "reported problems — the fix lines above name each one");
      renderer.fix(
        "fix what it named, then re-run `crabby onboard` — it skips what you already did",
      );
      return EXIT.failure;
    }
    stepDone("environment");

    // ── §5 step 2: model path ───────────────────────────────────────────────
    stepNow("model path");
    let target = state.defaultModel;
    if (!state.providerConfigured) {
      const choice = await choose(
        "Pick a model path (§5 step 2)",
        [
          {
            label: "Set up a provider now",
            hint: "any OpenAI-compatible endpoint — base URL, model id, optional key",
          },
          {
            label: "Skip for now",
            hint: "Crabby is usable without one; real tasks wait for a model (§5's skip path)",
          },
        ],
        p,
      );
      if (!choice.cancelled && choice.index === 0) {
        const name = (await ask("provider name (e.g. groq): ")) || "local";
        const baseUrl = await ask("base URL (e.g. https://api.groq.com/openai/v1): ");
        const modelId = await ask("model id (e.g. llama-3.3-70b-versatile): ");
        if (
          (await runVerb(
            input.repoRoot,
            ["provider", "add", name, "--base-url", baseUrl, "--model", modelId],
            renderer,
          )) !== 0
        ) {
          renderer.fix("`provider add` refused — its fix line above names the field");
        }
        const keyed = await ask("does this endpoint need an API key? [y/N] ");
        if (keyed.toLowerCase() === "y") {
          renderer.line(
            "vault",
            `the next prompt takes the key on stdin — type it and press Enter (never argv)`,
          );
          await runVerb(input.repoRoot, ["vault", "set", name], renderer);
          renderer.fix(
            `point the provider at it:  crabby config set provider.${name}.key vault://${name}`,
          );
        }
        target = `${name}/${modelId}`;
        await runVerb(input.repoRoot, ["config", "set", "defaultModel", target], renderer);
      } else {
        renderer.fix(
          "skipped — the mock endpoint composes today, and a real model can be added any time with `crabby provider add`",
        );
      }
    }
    stepDone("model path");

    // ── §5 step 3: workspace (display — M2m built the creation) ─────────────
    stepNow("workspace");
    let workspaceRoot = "$HOME/crabby-workspace";
    try {
      const configPath = path.join(input.layout.stateDir, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        workspace?: { root?: string };
      };
      if (typeof config.workspace?.root === "string") workspaceRoot = config.workspace.root;
    } catch {
      // the default sentence is the answer when the config says nothing
    }
    renderer.line(
      "workspace",
      `${workspaceRoot.replace(os.homedir(), "~")} — §8's deny-list stands guard around it`,
    );
    stepDone("workspace");

    // ── §5 step 4: shell access (a decided shell is never re-asked — re-run skips what is done) ──
    stepNow("shell");
    if (state.shellDecided) {
      renderer.line(
        "shell",
        "already decided in config (§4.2) — change it with `crabby config set shell.enabled …`",
      );
      stepDone("shell");
    }
    const shellChoice = state.shellDecided
      ? { index: 0, cancelled: false }
      : await choose(
          "Shell access (§5 step 4)",
          [
            {
              label: "Keep shell OFF (recommended)",
              hint: "the agent works with files, memory and tasks; no commands",
            },
            {
              label: "Enable shell",
              hint: "lets the agent run commands as your Termux user. That is not a sandbox. (§5's own sentence)",
            },
          ],
          p,
        );
    if (!state.shellDecided) {
      if (shellChoice.cancelled) {
        setStep("shell", "pending");
        renderer.fix("left undecided — you will be asked again; nothing was recorded");
      } else if (shellChoice.index === 1) {
        await runVerb(input.repoRoot, ["config", "set", "shell.enabled", "true"], renderer);
        renderer.fix("shell composes at the next Gateway start — which is the very next step");
      } else {
        await runVerb(input.repoRoot, ["config", "set", "shell.enabled", "false"], renderer);
      }
      stepDone("shell");
    }

    // ── §5 step 5: pairing ──────────────────────────────────────────────────
    stepNow("pairing");
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
        statuses.pairing = "failed";
        return EXIT.failure;
      }
      const ok = await redeemCode(input, pairing.code);
      if (!ok) {
        renderer.fix(
          "the code expired or was already used — harmless: stop the Gateway (Ctrl-C) and re-run `crabby onboard`; a fresh code is printed every start until one identity exists",
        );
        statuses.pairing = "failed";
        return EXIT.failure;
      }
    }
    stepDone("pairing");

    // ── §5 step 6: prove the loop ───────────────────────────────────────────
    stepNow("first chat");
    if (target !== undefined) {
      renderer.line(
        "verify",
        `asking ${target} for one small completion — the promise is a working model, not a saved key`,
      );
      const answered = await verifyModel(input.repoRoot, target);
      if (!answered) {
        renderer.fix(
          `crabby model probe ${target} by hand shows the exact failure; onboarding is still saved`,
        );
        statuses["first chat"] = "failed";
        return EXIT.failure;
      }
      renderer.line("verify", `${target} answered ✓`);
      const chatChoice = await choose(
        "Say hello now? (§5's first task)",
        [
          {
            label: "Yes — one short chat",
            hint: 'runs `crabby chat "Say hello in one short sentence."` right here',
          },
          { label: "Not now", hint: "everything is saved; the same command works any time" },
        ],
        p,
      );
      if (!chatChoice.cancelled && chatChoice.index === 0) {
        await runVerb(input.repoRoot, ["chat", "Say hello in one short sentence."], renderer);
      }
      stepDone("first chat");
    } else {
      statuses["first chat"] = "pending";
      renderer.fix(
        "no model to verify yet — `crabby model probe <name>/<model-id>` after adding one",
      );
    }

    renderer.line("", "");
    renderer.line("onboard", `${p.green("done")} — what you can type now:`);
    renderer.line("  chat", 'crabby chat "…" — one question, one answer');
    renderer.line("  task", 'crabby task run "…" — a multi-step task with approvals');
    renderer.line("  tui", "crabby tui — the full terminal UI");
    renderer.line("  web", "crabby web open — the browser dashboard");
    renderer.fix("the Gateway keeps running in this terminal; Ctrl-C stops it (D-066's drain)");
    renderer.fix("re-run `crabby onboard` any time — it skips what is already done");
    return EXIT.success;
  })();
}
