// `crabby diagnostics` — C12-08's row: "sanitized report to a file, path printed", "the same artifact the Web's Export
// button produces (`GET /diagnostics`)", and "it refuses to include env vars or key material rather than redacting
// after the fact".
//
// Three choices follow from that sentence rather than from convenience. The bytes come from the route, not from this
// process, so the file a phone writes is the same artifact the Web downloads and the CLI cannot add a field the
// Gateway did not decide to publish. The report lands in the OS temp directory, not the data directory: D-078's table
// is the list of files that directory *owns* and prunes, and a paste-able one-shot artifact that nobody retires is how
// a secret-shaped file survives on a shared device. And the file is written only after a scan for the shapes a report
// must never carry — which is what "refuses … rather than redacting after the fact" asks for, since a redactor that
// runs after the write has already written.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

/** What a diagnostics artifact may not contain. These are checked against the *serialized* report, so the refusal does
 *  not depend on which field name the Gateway happened to use. */
const FORBIDDEN_SHAPES: readonly {
  readonly label: string;
  readonly test: (text: string) => boolean;
}[] = [
  { label: "an environment snapshot", test: (text) => /"env"\s*:|process\.env/.test(text) },
  {
    label: "a bearer token or pairing code",
    test: (text) => /"token"\s*:|"authorization"\s*:|crabby_[a-z0-9_]{8,}/i.test(text),
  },
  { label: "a private key", test: (text) => /BEGIN [A-Z ]*PRIVATE KEY/.test(text) },
];

/** The refusal, exported because it is the part of this command that carries a promise rather than plumbing: §4's
 *  `GET /diagnostics` is the artifact a user pastes into a bug report, and "refuses … rather than redacting after the
 *  fact" is only true if the check happens before the write. A test must be able to knock on that sentence alone. */
export function findUnsafeShapes(text: string): readonly string[] {
  return FORBIDDEN_SHAPES.filter((shape) => shape.test(text)).map((shape) => shape.label);
}

/** Writes the artifact and reports what it wrote. `dir` defaults to the OS temp directory for the reason in the header
 *  comment; a caller that needs the bytes elsewhere (a test) passes it, so the promise being checked — mode 0600 — is
 *  checked on a file the caller can also remove. */
export function writeDiagnosticsArtifact(
  text: string,
  dir: string = tmpdir(),
): { readonly file: string; readonly bytes: number } {
  const file = path.join(
    dir,
    `crabby-diagnostics-${timestamp()}-${randomBytes(3).toString("hex")}.json`,
  );
  writeFileSync(file, text, { mode: 0o600 });
  return { file, bytes: text.length };
}

export async function runDiagnostics(
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("diagnostics", undefined);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this command accepts`);
    return EXIT.usage;
  }
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);

  try {
    const response = await connection.client.diagnostics();
    const text = `${JSON.stringify(response.body, null, 2)}\n`;
    const problems = findUnsafeShapes(text);
    if (problems.length > 0) {
      // Refuse, name what was found, and write nothing. The report is meant to be pasted into a bug report, so a file
      // that would embarrass the user later is worse than no file.
      renderer.line("report refused", problems.join(", "));
      renderer.fix(
        "the Gateway must not include those in GET /diagnostics; report this as a bug rather than editing the file",
      );
      return renderer.fail({
        code: "diagnostics_unsafe",
        message: "the report carries something it should not",
      });
    }
    const { file, bytes } = writeDiagnosticsArtifact(text);
    renderer.line("report", `${file} (${bytes} bytes)`);
    renderer.fix(
      "safe to paste into a bug report; it is not deleted, so remove it when you are done",
    );
    return renderer.done({ path: file, bytes, requestId: response.requestId ?? null });
  } catch (error) {
    return reportFailure(renderer, error);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
