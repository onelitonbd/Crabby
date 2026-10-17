// §4.4's `/memory` rows as `crabby memory` verbs — region C9's accepted spec, where "review" is a listing a person can
// read and "forget" is a deletion that shows what it will touch before it touches it.
//
// The rules this file refuses to re-state: provenance ranks, conflict display, what a review approves — all live in
// the store the Gateway answers from, and the verbs render bodies. Three accepted rows shape the interaction:
//
//   - C9-03/C9-04: the list carries provenance and trust; the search says "text search" because D-021 scoped v1 to
//     text and a UI that implies semantics is lying about what it did.
//   - C9-05: `memory forget` prints what referenced the entry *before* deleting — the preview is fetched from the
//     route, printed, and only then is the delete sent, so the user always saw the propagation before it happened.
//   - C9-06: `memory forget-topic` is the broad one. It counts what it will touch and prints the count even with
//     `--yes` — the flag skips the confirmation, never the count — and without `--yes` it stops at the preview,
//     because "forget everything about X" typed in anger should cost one more deliberate keystroke.
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

export type MemoryVerb = "list" | "search" | "forget" | "forget-topic";

interface MemoryEntryBody {
  readonly id: string;
  readonly content: string;
  readonly category?: string;
  readonly origin: string;
  readonly sourceKind: string;
  readonly sourceId?: string;
  readonly sourceMissing?: boolean;
  readonly sourceCount: number;
  readonly external?: boolean;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ListPage {
  readonly entries: readonly MemoryEntryBody[];
  readonly counts: { active: number; superseded: number; needsReview: number; pending: number };
}

interface Preview {
  readonly entry: MemoryEntryBody;
  readonly trust: string;
  readonly references?: readonly {
    memoryId: string;
    sessionId?: string;
    taskId?: string;
    at: string;
  }[];
}

export async function runMemory(
  verb: MemoryVerb | string | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("memory", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }
  if (verb !== "list" && verb !== "search" && verb !== "forget" && verb !== "forget-topic") {
    renderer.line("memory", "which verb? `list`, `search`, `forget`, `forget-topic`");
    renderer.fix("crabby memory list is the read this build starts with");
    return EXIT.usage;
  }
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  const client = connection.client;

  try {
    if (verb === "list") {
      const status = tail.values["status"];
      const route =
        status === undefined
          ? "/api/v1/memory"
          : `/api/v1/memory?status=${encodeURIComponent(status)}`;
      const page = (await client.request<ListPage>(route)).body as ListPage;
      for (const entry of page.entries) renderer.line(labelFor(entry), previewText(entry));
      renderer.line(
        "counts",
        `${page.counts.active} active · ${page.counts.pending} proposed · ${page.counts.needsReview} need review · ` +
          `${page.counts.superseded} superseded`,
      );
      return renderer.done({ ...page });
    }

    if (verb === "search") {
      const query = tail.positionals.join(" ").trim();
      if (query.length === 0) {
        renderer.line("memory search", "a search without a query searches nothing");
        renderer.fix('crabby memory search "wifi password"');
        return EXIT.usage;
      }
      const page = (
        await client.request<{ entries: readonly MemoryEntryBody[]; note: string }>(
          `/api/v1/memory/search?q=${encodeURIComponent(query)}`,
        )
      ).body as { entries: readonly MemoryEntryBody[]; note: string };
      for (const entry of page.entries) renderer.line(labelFor(entry), previewText(entry));
      renderer.line(
        "found",
        `${page.entries.length} entr${page.entries.length === 1 ? "y" : "ies"} (text search only in v1 — D-021)`,
      );
      return renderer.done({ query, entries: page.entries });
    }

    // Both forgets share the shape: preview first, then the act. The single-entry forget acts on what it showed; the
    // topic forget asks for `--yes` between the two, because its scope is the user's phrase, not one named entry.
    const positionals = tail.positionals;
    if (positionals.length === 0) {
      renderer.line(
        `memory ${verb}`,
        verb === "forget" ? "which entry? name its id" : "forget everything about what?",
      );
      renderer.fix(
        verb === "forget"
          ? "crabby memory list prints the ids"
          : 'crabby memory forget-topic "the old apartment"',
      );
      return EXIT.usage;
    }

    if (verb === "forget") {
      const id = positionals[0] ?? "";
      const preview = (await client.request<Preview>(`/api/v1/memory/${id}`)).body as Preview;
      renderer.line(labelFor(preview.entry), previewText(preview.entry));
      const references = preview.references ?? [];
      renderer.line(
        "referenced by",
        references.length === 0
          ? "nothing on record"
          : references
              .map((reference) =>
                reference.sessionId !== undefined
                  ? `session ${reference.sessionId}`
                  : `task ${reference.taskId ?? "unknown"}`,
              )
              .join(", "),
      );
      const removed = (
        await client.request<{ entry: MemoryEntryBody; references: unknown[] }>(
          `/api/v1/memory/${id}`,
          {
            method: "DELETE",
          },
        )
      ).body as { entry: MemoryEntryBody; references: unknown[] };
      renderer.line(
        "forgotten",
        `${removed.entry.id} — ${removed.references.length} reference${removed.references.length === 1 ? "" : "s"} went with it`,
      );
      return renderer.done({ forgotten: removed.entry, references: removed.references });
    }

    const phrase = positionals.join(" ").trim();
    const matches = (
      await client.request<{ entries: readonly MemoryEntryBody[] }>(
        `/api/v1/memory/search?q=${encodeURIComponent(phrase)}`,
      )
    ).body as { entries: readonly MemoryEntryBody[] };
    const active = matches.entries.filter((entry) => entry.status === "active");
    renderer.line(
      "would forget",
      `${active.length} active entr${active.length === 1 ? "y" : "ies"} matching '${phrase}'`,
    );
    for (const entry of active) renderer.line(`  ${entry.id}`, previewText(entry));
    if (tail.booleans.has("--yes") === false) {
      renderer.fix("re-run with --yes to forget them; the count above is what --yes acts on");
      return renderer.done({ phrase, wouldForget: active.length, executed: false });
    }
    let removed = 0;
    for (const entry of active) {
      await client.request(`/api/v1/memory/${entry.id}`, { method: "DELETE" });
      removed += 1;
    }
    renderer.line("forgotten", `${removed} entr${removed === 1 ? "y" : "ies"}`);
    return renderer.done({ phrase, executed: true, removed });
  } catch (error) {
    return reportFailure(renderer, error);
  }
}

function labelFor(entry: MemoryEntryBody): string {
  const bits = [
    entry.id,
    entry.category === undefined ? "" : `#${entry.category}`,
    `[${entry.origin}]`,
    entry.status === "active" ? "" : `[${entry.status.replace("-", " ")}]`,
    entry.external === true ? "[unconfirmed]" : "",
  ];
  return bits.filter((bit) => bit !== "").join(" ");
}

function previewText(entry: MemoryEntryBody): string {
  const source =
    entry.sourceMissing === true
      ? "source deleted"
      : entry.sourceId === undefined
        ? entry.sourceKind
        : `${entry.sourceKind} ${entry.sourceId}`;
  const text = entry.content.length > 90 ? `${entry.content.slice(0, 89)}…` : entry.content;
  return `${text} · ${source}`;
}
