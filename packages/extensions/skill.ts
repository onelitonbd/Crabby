// The `SKILL.md` frontmatter contract (D-071, §4.3): a skill often arrives without a manifest, so its frontmatter is
// its manifest, and each field is treated in one of three ways — honored, displayed, or **recorded and never granted** —
// because "we can read this" and "we trust this" are different questions.
//
// The two size rules are §4.3's own, and they are different rules on purpose: over **500 lines** is a validation
// *warning* recommending a split, while a body over **32 KiB** is *refused at activation* with the instruction to move
// material into `references/` — truncating instructions is the one thing a skill loader may never do, because a
// truncated rule reads exactly like a complete one and the model will follow the part that survived.
import { parse as parseYaml } from "yaml";

export const SKILL_FILE = "SKILL.md";
export const BODY_SOFT_LINE_LIMIT = 500;
export const BODY_MAX_BYTES = 32 * 1024;

export const METADATA_KEYS = ["version", "author", "tags"] as const;

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  /** Displayed, never enforced (§4.3): free prose about where the author tested it, copied into the conversion report. */
  readonly compatibility?: string;
  readonly metadata: {
    readonly version?: string;
    readonly author?: string;
    readonly tags?: readonly string[];
    /** Namespaced `crabby.*` keys are interpreted; anything beside them is preserved verbatim and unread. */
    readonly crabby?: Readonly<Record<string, unknown>>;
    /** Metadata keys we do not understand, verbatim — a field we do not understand must survive a round trip (§4.3). */
    readonly unknown: Readonly<Record<string, unknown>>;
  };
  /** Recorded, never granted (§4.3's whole note): the upstream format's tool pre-approval, read for the capability
   *  diff and flagged for review at install, never applied. */
  readonly allowedTools?: readonly string[];
}

export interface SkillProblems {
  readonly errors: readonly { readonly path: string; readonly message: string }[];
  readonly warnings: readonly { readonly path: string; readonly message: string }[];
  /** §4.3's "ignored loudly" lines: every frontmatter key that is not in D-071's table, named for the report. */
  readonly unknownFields: readonly string[];
  readonly preserved: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly bodyLines: number;
  readonly bodyBytes: number;
  /** The 32 KiB rule's verdict: the file validates, and activation refuses — the two answers must stay separable. */
  readonly activationBlocked: boolean;
}

export type SkillParseResult =
  | { readonly ok: true; readonly frontmatter: SkillFrontmatter; readonly report: SkillProblems }
  | {
      readonly ok: false;
      readonly errors: readonly { readonly path: string; readonly message: string }[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split `---`-fenced frontmatter from the body. What is not frontmatter at all is an error naming the shape, not a
 *  guess about where the metadata ended. */
function split(text: string): { readonly head: string; readonly body: string } | undefined {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const head = text.slice(3, end).trim();
  let body = text.slice(end + 4);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { head, body };
}

export function parseSkill(text: string, folderName: string): SkillParseResult {
  const parts = split(text);
  if (parts === undefined) {
    return {
      ok: false,
      errors: [
        {
          path: "(frontmatter)",
          message:
            "SKILL.md must open with `---`-fenced frontmatter (D-071) — a skill without it has no name and no " +
            "description, and a file we cannot describe is a file we cannot install under a name it agrees to",
        },
      ],
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(parts.head);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "(frontmatter)",
          message: `the frontmatter is not parsable YAML: ${(error as Error).message}`,
        },
      ],
    };
  }
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [{ path: "(frontmatter)", message: "the frontmatter must be a mapping" }],
    };
  }

  const errors: { path: string; message: string }[] = [];
  const warnings: { path: string; message: string }[] = [];
  const unknownFields: string[] = [];
  const preserved: Record<string, unknown> = {};

  const known = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
  ]);
  for (const key of Object.keys(raw)) {
    // An imported skill is lenient where a native manifest is strict (§4.3's closing note): recorded, preserved in the
    // source form inside the imported folder, never read — the named line is what makes the recording honest.
    if (!known.has(key)) {
      unknownFields.push(key);
      preserved[key] = raw[key];
    }
  }

  const name = raw.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    errors.push({
      path: "name",
      message: `'name' is required, 1–64 characters (${String(name).slice(0, 40)} arrived)`,
    });
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    errors.push({
      path: "name",
      message: `'${name}' is not the format's name shape: lowercase letters, digits and single interior hyphens`,
    });
  } else if (name !== folderName) {
    // The hard error, not a warning (§4.3): the name is the install key, and a skill that installs under a name its
    // folder denies is two sources of truth.
    errors.push({
      path: "name",
      message:
        `the frontmatter names '${name}' but the folder is '${folderName}' — a mismatch is a hard error, ` +
        "because the name is the install key",
    });
  }
  const description = raw.description;
  if (typeof description !== "string" || description.length === 0 || description.length > 1024) {
    errors.push({
      path: "description",
      message:
        `'description' is required, 1–1024 characters (${typeof description}, ` +
        `${typeof description === "string" ? description.length : ""} arrived) — it is model-visible, which is why ` +
        "the bound is part of the contract",
    });
  }
  if (raw.license === undefined) {
    warnings.push({
      path: "license",
      message:
        "no 'license' field — absence is a warning, not a block (§4.3): the ecosystem ships both",
    });
  } else if (typeof raw.license !== "string") {
    errors.push({ path: "license", message: "'license' must be a string when present" });
  }
  if (raw.compatibility !== undefined && typeof raw.compatibility !== "string") {
    // Displayed, not enforced — but displayed text is still text, so a non-string is recorded as it stands.
    warnings.push({
      path: "compatibility",
      message:
        "'compatibility' is displayed, not enforced (§4.3); this one is not a string and is preserved verbatim",
    });
    preserved.compatibility = raw.compatibility;
  }

  let metadata: SkillFrontmatter["metadata"] = { unknown: {} };
  const metadataRaw = raw.metadata;
  if (metadataRaw !== undefined) {
    if (!isRecord(metadataRaw)) {
      errors.push({ path: "metadata", message: "'metadata' must be a mapping when present" });
    } else {
      const unknownMeta: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(metadataRaw)) {
        const knownKey = (METADATA_KEYS as readonly string[]).includes(key);
        const namespaced = key.startsWith("crabby.");
        if (!knownKey && !namespaced) {
          unknownMeta[key] = value;
          unknownFields.push(`metadata.${key}`);
        }
      }
      metadata = {
        ...(typeof metadataRaw.version === "string" ? { version: metadataRaw.version } : {}),
        ...(typeof metadataRaw.author === "string" ? { author: metadataRaw.author } : {}),
        ...(Array.isArray(metadataRaw.tags)
          ? { tags: metadataRaw.tags.filter((t) => typeof t === "string") }
          : {}),
        ...(isRecord(metadataRaw["crabby.self"]) ||
        Object.keys(metadataRaw).some((k) => k.startsWith("crabby."))
          ? {
              crabby: Object.fromEntries(
                Object.entries(metadataRaw).filter(([k]) => k.startsWith("crabby.")),
              ),
            }
          : {}),
        unknown: unknownMeta,
      };
    }
  }

  let allowedTools: readonly string[] | undefined;
  if (raw["allowed-tools"] !== undefined) {
    const value = raw["allowed-tools"];
    // Recorded, never granted — and recorded in whatever shape it arrived, because a half-parsed permission list
    // would read as a permission we understood.
    if (Array.isArray(value)) {
      allowedTools = value.filter((entry): entry is string => typeof entry === "string");
      if (allowedTools.length !== value.length) {
        warnings.push({
          path: "allowed-tools",
          message:
            "some entries were not strings and are preserved verbatim in the report rather than mapped",
        });
        // The mapped list is the string subset; the original ships whole so the report drops nothing silently.
        preserved["allowed-tools"] = value;
      }
    } else if (typeof value === "string") {
      allowedTools = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    } else {
      allowedTools = [];
      warnings.push({
        path: "allowed-tools",
        message:
          "not a list this build can map into §6.1's vocabulary — recorded verbatim, granted never",
      });
      preserved["allowed-tools"] = value;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  // The validation above has pinned both required fields to strings; these locals are the type-level record of
  // that invariant (the checks push errors instead of returning, so the narrows do not survive on their own).
  const resolvedName = name as string;
  const resolvedDescription = description as string;

  const bodyLines = parts.body.length === 0 ? 0 : parts.body.split("\n").length;
  const bodyBytes = Buffer.byteLength(parts.body, "utf8");
  if (bodyLines > BODY_SOFT_LINE_LIMIT) {
    warnings.push({
      path: "(body)",
      message:
        `the body is ${bodyLines} lines; over ${BODY_SOFT_LINE_LIMIT} §4.3 recommends a split, with the ` +
        "bulk moved into `references/` the skill can point at",
    });
  }
  const activationBlocked = bodyBytes > BODY_MAX_BYTES;
  if (activationBlocked) {
    warnings.push({
      path: "(body)",
      message:
        `the body is ${bodyBytes} bytes; over ${BODY_MAX_BYTES} the skill validates but activation refuses ` +
        "(§4.3), because truncating instructions is the one thing a skill loader may never do — move material into " +
        "`references/`",
    });
  }

  return {
    ok: true,
    frontmatter: {
      name: resolvedName,
      description: resolvedDescription,
      ...(typeof raw.license === "string" ? { license: raw.license } : {}),
      ...(typeof raw.compatibility === "string" ? { compatibility: raw.compatibility } : {}),
      metadata,
      ...(allowedTools === undefined ? {} : { allowedTools }),
    },
    report: {
      errors,
      warnings,
      unknownFields,
      preserved,
      body: parts.body,
      bodyLines,
      bodyBytes,
      activationBlocked,
    },
  };
}
