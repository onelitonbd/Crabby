// One validation path for every schema, because `docs/INTERFACES_AND_API.md` §2 requires two things a bare
// `Value.Check` cannot give: unknown
// fields rejected *with the field named*, and a shape the four interfaces can print the same way. The walker below
// resolves a JSON Pointer against the schema's own `properties`, which is how a name gets attached to a deep miss.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { ValueError } from "@sinclair/typebox/errors";
import { Errors } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";

export type Problem = { path: string; message: string; kind: "unknown-field" | "invalid" };

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

export function validate<T extends TSchema>(
  schema: T,
  input: unknown,
  extra: readonly Problem[] = [],
): ValidationResult<Static<T>> {
  const problems: Problem[] = [...extra, ...unknownFields(schema, input, "")];
  for (const err of Errors(schema, input)) problems.push(toProblem(err));
  if (problems.length > 0) return { ok: false, problems: dedupe(problems) };
  // no Cast: a validator that quietly rewrote the payload would hide a producer bug behind a passing check
  return { ok: true, value: input as Static<T> };
}

export function isValid<T extends TSchema>(schema: T, input: unknown): input is Static<T> {
  return Value.Check(schema, input);
}

/** `CrabbyEnvelope` style wrapper every read command can print: `ok`, the payload, and the request id when one exists. */
export const ResultEnvelope = <T extends TSchema>(data: T) =>
  Type.Object(
    { ok: Type.Literal(true), data, requestId: Type.Optional(Type.String()) },
    { additionalProperties: false },
  );

function unknownFields(schema: TSchema, value: unknown, path: string): Problem[] {
  const props = (schema as { properties?: Record<string, TSchema> }).properties;
  if (!props || typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const out: Problem[] = [];
  for (const key of Object.keys(value)) {
    const child = props[key];
    if (child === undefined) {
      out.push({
        path: `${path}/${key}`,
        message: `unknown field '${key}' is not part of the contract`,
        kind: "unknown-field",
      });
      continue;
    }
    const childValue = (value as Record<string, unknown>)[key];
    out.push(...unknownFields(child, childValue, `${path}/${key}`));
  }
  return out;
}

function toProblem(err: ValueError): Problem {
  return { path: err.path, message: messageOf(err), kind: "invalid" };
}

function messageOf(err: ValueError): string {
  const key = lastSegment(err.path);
  switch (err.message) {
    case undefined:
      return `at ${err.path || "/"}`;
    default:
      return key ? `${err.message.replace(/\.$/, "")} (at '${key}')` : err.message;
  }
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function dedupe(problems: Problem[]): Problem[] {
  // A `patternProperties`-free object with `additionalProperties: false` reports the same mistake twice: once from
  // the walker, which can name the field, and once from TypeBox, which cannot. §2 asks for the named one, so a path
  // the walker already explained drops its generic twin.
  const named = new Set(problems.filter((p) => p.kind === "unknown-field").map((p) => p.path));
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const p of problems) {
    if (p.kind !== "unknown-field" && named.has(p.path)) continue;
    const key = `${p.kind}\u0000${p.path}\u0000${p.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Where a validation failure belongs in the error envelope: the class is always `validation`, and the message lists
 *  the offending fields rather than the first one, because a client fixes more in one round trip. */
export function validationFailure(problems: readonly Problem[]): {
  message: string;
  fields: string[];
} {
  const fields = problems.map((p) => p.path.replace(/^\//, "").replace(/\//g, "."));
  const lines = problems
    .slice(0, 8)
    .map((p) => `${p.path.replace(/^\//, "").replace(/\//g, ".")}: ${p.message}`);
  return { message: lines.join("; "), fields };
}
