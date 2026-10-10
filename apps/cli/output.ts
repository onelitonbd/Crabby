// The two output modes `docs/INTERFACES_AND_API.md` §7.1 promises — a human line per fact, or `--json` as one machine document — and the one rule
// that keeps them from drifting: a command builds a *result object* and this module decides how it is rendered. No
// command prints its own prose, because the moment it does, `--json` starts lying.
//
// §7.1: "Output must be pipeable and free of color when not a TTY." Nothing here ever writes an escape sequence, so
// that rule cannot be broken by a command that wanted a colored heading.
import { EXIT, type ExitCode } from "@crabby/api-contracts";

export interface Renderer {
  readonly json: boolean;
  /** Human output. In JSON mode these are swallowed, because the document is the output. */
  line(label: string, detail?: string | undefined): void;
  /** A document rather than a field — `config schema` and `diagnostics` print JSON the user asked to *look at*, so it
   *  goes to stdout verbatim in both modes and never gets a label column in front of it. */
  raw(text: string): void;
  /** A line the user has to act on: it survives in both modes, and in JSON it becomes `fixes[]`. */
  fix(text: string): void;
  /** The result document. Returns the exit code so a command can `return render(...)`. */
  done(payload: Record<string, unknown>): ExitCode;
  fail(payload: Record<string, unknown> & { code?: string; message?: string }): ExitCode;
}

export function createRenderer(
  streams: { write: (s: string) => void; err: (s: string) => void },
  json: boolean,
): Renderer {
  const fixes: string[] = [];
  return {
    json,
    line(label, detail) {
      if (!json) streams.write(detail ? `${pad(label)}${detail}\n` : `${label}\n`);
    },
    raw(text) {
      streams.write(`${text}\n`);
    },
    fix(text) {
      fixes.push(text);
      if (!json) streams.write(`  → ${text}\n`);
    },
    done(payload) {
      // A fix line is printed the moment the fact that needs it is printed, so the human path never repeats them in a
      // trailing block; `fixes[]` in the document exists because a script has no ordering to read.
      if (json) {
        streams.write(
          `${JSON.stringify({ ok: true, ...payload, ...(fixes.length > 0 ? { fixes } : {}) }, null, 2)}\n`,
        );
      }
      return EXIT.success;
    },
    fail({ code, message, ...rest }) {
      if (json) {
        streams.write(
          `${JSON.stringify({ ok: false, code: code ?? "failure", message: message ?? "failed", ...rest, ...(fixes.length > 0 ? { fixes } : {}) }, null, 2)}\n`,
        );
      } else if (message) {
        streams.err(`${message}\n`);
      }
      return EXIT.failure;
    },
  };
}

const LABEL_WIDTH = 18;

function pad(label: string): string {
  return label.length >= LABEL_WIDTH
    ? `${label}  `
    : `${label}${" ".repeat(LABEL_WIDTH - label.length)}`;
}
