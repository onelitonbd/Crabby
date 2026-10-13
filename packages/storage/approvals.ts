// The approval repository: `SECURITY.md` §6.3's request, answer and expiry, in the one table four surfaces read.
//
// `ARCHITECTURE.md` §19 is why this file imports a type from the runtime and not the other way round: "Infrastructure
// adapters implement those abstractions". The abstraction is `ApprovalStore`, owned by
// `packages/agent-runtime/approvals.ts` (D-084 — the arbiter of an approval cannot be one of the parties answering it),
// and the runtime imports no database at all. A reviewer who would rather the record type lived in
// `@crabby/api-contracts` is not wrong, but `ApprovalRequest.tier` is a `Tier`, and `Tier` is
// `packages/policy`'s by D-080; moving it to the contract layer would move the tier table's owner, so the adapter
// reaches one level up and the dependency still points the way §19 draws it.
//
// Two decisions worth having in the file rather than in a migration log:
//
//   - The request is stored twice on purpose: as `request_json`, which is what a client reads back, and as promoted
//     columns, which are what a `SELECT` filters on. Both are written from one object in one statement, because a row
//     whose columns came from a different copy of the request than its blob is a row that can disagree with itself.
//   - `update` has no `request_json`, no `expires_at` and no `task_id` in its `SET` list. That is not an oversight: the
//     answer to an approval must not be able to rewrite what the user was shown, and the cleanest way to guarantee it
//     is to give the statement no columns to rewrite it with. The state machine still decides every state; the schema
//     just refuses to be the place where a binding quietly changed.

import type { ApprovalRecord, ApprovalStore } from "@crabby/agent-runtime";
import { APPROVAL_STATES, type ApprovalState } from "@crabby/api-contracts";
import type { SqliteDb } from "./db.ts";

export const APPROVAL_TABLE = "approval";

const COLUMNS = `id, task_id, tool, tier, binding, state, requested_at, expires_at,
       answered_at, answered_by, consumed_at, supersedes, request_json`;

interface ApprovalRow {
  readonly id: string;
  readonly task_id: string;
  readonly tool: string;
  readonly tier: string;
  readonly binding: string;
  readonly state: string;
  readonly requested_at: number;
  readonly expires_at: number;
  readonly answered_at: number | null;
  readonly answered_by: string | null;
  readonly consumed_at: number | null;
  readonly supersedes: string | null;
  readonly request_json: string;
}

/** A row that does not carry a state the runtime can be in is a corrupted file, not a state nobody thought of: SQLite
 *  stores `TEXT` in any `TEXT` column whatever a `CHECK` says was allowed, so a database written by an older or a
 *  hand-edited build fails here loudly. Reading it back as an arbitrary string would put a `state` in a client's hands
 *  that no transition rule produced. */
function toRecord(row: ApprovalRow): ApprovalRecord {
  const state = row.state as ApprovalState;
  if (!APPROVAL_STATES.includes(state)) {
    throw new Error(
      `approval ${row.id} is stored in state \`${row.state}\`, which is not one of ${APPROVAL_STATES.join(
        ", ",
      )} — restore from backup or delete the row (\`docs/DATA_AND_MEMORY.md\` §8)`,
    );
  }
  const request = JSON.parse(row.request_json) as ApprovalRecord["request"];
  // The promoted columns and the blob must agree, and the only cheap way to know they do is to look: a row where
  // `task_id` and `request.taskId` disagree is exactly the "columns from one copy, blob from another" failure the
  // header refuses to allow, and it can only arrive via a hand edit or a migration bug.
  if (
    request.taskId !== row.task_id ||
    request.tool !== row.tool ||
    request.binding !== row.binding ||
    request.expiresAt !== row.expires_at
  ) {
    throw new Error(
      `approval ${row.id} disagrees with itself — its columns say task \`${row.task_id}\`, tool \`${row.tool}\`, ` +
        "and the request stored beside them says otherwise",
    );
  }
  return {
    id: row.id,
    request,
    requestedAt: row.requested_at,
    state,
    ...(row.answered_at === null ? {} : { answeredAt: row.answered_at }),
    ...(row.answered_by === null ? {} : { answeredBy: row.answered_by }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
  };
}

export function createSqliteApprovalStore(db: SqliteDb): ApprovalStore {
  const insert = db.prepare(
    `INSERT INTO approval (id, task_id, tool, tier, binding, state, requested_at, expires_at,
                           answered_at, answered_by, consumed_at, supersedes, request_json)
     VALUES (@id, @task_id, @tool, @tier, @binding, @state, @requested_at, @expires_at,
             @answered_at, @answered_by, @consumed_at, @supersedes, @request_json)`,
  );
  const update = db.prepare(
    `UPDATE approval
        SET state = @state, answered_at = @answered_at, answered_by = @answered_by,
            consumed_at = @consumed_at
      WHERE id = @id`,
  );
  return {
    insert(record) {
      insert.run(toRow(record));
      // `INSERT` and not `INSERT OR REPLACE`, because a colliding id is a bug in the caller and replacing the row
      // would hide it: a second request that overwrote a pending one would silently withdraw an approval somebody was
      // looking at. `deduplicated` in the service is the answer to a repeat, not a replace.
    },
    update(record) {
      const result = update.run({
        id: record.id,
        state: record.state,
        answered_at: record.answeredAt ?? null,
        answered_by: record.answeredBy ?? null,
        consumed_at: record.consumedAt ?? null,
      });
      if (result.changes !== 1) {
        // An update that matched nothing means the row is gone — a `delete-session` cascade (§7) that raced an answer.
        // Saying nothing would let the caller log a decision no row carries, which is the one disagreement D-084
        // exists to make impossible.
        throw new Error(
          `approval ${record.id} is no longer in the table, so the ${record.state} answer cannot be recorded — a ` +
            "pending approval is deleted with its task (docs/DATA_AND_MEMORY.md §7)",
        );
      }
    },
    get(id) {
      const row = db.prepare(`SELECT ${COLUMNS} FROM approval WHERE id = ?`).get(id) as
        | ApprovalRow
        | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    all() {
      // Ordered by `rowid`, which is insertion order and survives a restart, so the queue a client reads at 09:00 is
      // the same list in the same order at 09:05 whatever the planner decides to do with the indexes. No cache: a
      // cached queue is a queue that lies to the second client.
      const rows = db
        .prepare(`SELECT ${COLUMNS} FROM approval ORDER BY rowid ASC`)
        .all() as ApprovalRow[];
      return rows.map(toRecord);
    },
  };
}

function toRow(record: ApprovalRecord) {
  return {
    id: record.id,
    task_id: record.request.taskId,
    tool: record.request.tool,
    tier: record.request.tier,
    binding: record.request.binding,
    state: record.state,
    requested_at: record.requestedAt,
    expires_at: record.request.expiresAt,
    answered_at: record.answeredAt ?? null,
    answered_by: record.answeredBy ?? null,
    consumed_at: record.consumedAt ?? null,
    supersedes: record.supersedes ?? null,
    request_json: JSON.stringify(record.request),
  };
}
