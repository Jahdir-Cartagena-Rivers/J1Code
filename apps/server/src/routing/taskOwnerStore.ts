import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { CurrentOwnerShell, OwnerEndpoint } from "./ownerDiscovery.ts";

const Id = Schema.String.check(Schema.isPattern(/\S/));
const Binding = Schema.Struct({
  bindingId: Id,
  taskId: Id,
  environmentId: Id,
  projectId: Id,
  threadId: Id,
});
const Provenance = Schema.Struct({
  principalId: Id,
  requestId: Id,
  authenticatedAt: Schema.Number.check(Schema.isFinite()),
});
const decodeId = Schema.decodeEffect(Id);
const decodeBinding = Schema.decodeEffect(Binding);
const decodeProvenance = Schema.decodeEffect(Provenance);
const decodeProvenanceJson = Schema.decodeEffect(Schema.fromJsonString(Provenance));
const encodeProvenanceJson = Schema.encodeEffect(Schema.fromJsonString(Provenance));
export type TaskOwnerBinding = typeof Binding.Type;
export type TaskOwnerProvenance = typeof Provenance.Type;
export interface StoredTaskOwner extends TaskOwnerBinding {
  readonly provenance: TaskOwnerProvenance;
  readonly revocation: TaskOwnerProvenance | null;
}
export class TaskOwnerStoreError extends Schema.TaggedError<TaskOwnerStoreError>()(
  "TaskOwnerStoreError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

/** Server-only dependency. Authenticate the action, authorize this exact task/endpoint,
 * and verify the thread's project/environment from J1 state. Never accept provenance
 * supplied by an agent, a title, or an opaque Hive client ID. Throw on denial.
 */
export interface TaskOwnerVerifier {
  readonly verify: (
    action: "bind" | "revoke",
    binding: TaskOwnerBinding,
  ) => Effect.Effect<TaskOwnerProvenance, TaskOwnerStoreError>;
}
export interface TaskOwnerLookup {
  readonly status: "none" | "bound" | "ambiguous" | "unavailable";
  readonly owner: OwnerEndpoint | null;
  readonly bindings: readonly StoredTaskOwner[];
}
interface Row {
  binding_id: string;
  task_id: string;
  environment_id: string;
  project_id: string;
  thread_id: string;
  provenance_json: string;
  revocation_json: string | null;
}
const fromRow = Effect.fnUntraced(function* (row: Row) {
  return {
    bindingId: row.binding_id,
    taskId: row.task_id,
    environmentId: row.environment_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    provenance: yield* decodeProvenanceJson(row.provenance_json),
    revocation:
      row.revocation_json === null ? null : yield* decodeProvenanceJson(row.revocation_json),
  };
});

/** Isolated infrastructure: migration registration, authenticated verifier, lifecycle hooks,
 * ownerDiscovery evidence freshness and routing admission remain integration work.
 * lookupDurable returns active persisted claims, NOT delivery readiness. lookupCurrent
 * additionally checks a fresh J1 shell snapshot; ambiguity never silently picks a winner.
 * history includes revoked claims. Rebind after revocation requires a NEW binding ID.
 */
export const makeTaskOwnerStore = (verifier: TaskOwnerVerifier) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const get = Effect.fn("TaskOwnerStore.get")(function* (bindingId: string) {
      const rows =
        yield* sql<Row>`SELECT * FROM task_owner_bindings WHERE binding_id = ${bindingId}`;
      return rows[0] ? yield* fromRow(rows[0]) : null;
    });
    const history = Effect.fn("TaskOwnerStore.history")(function* (
      taskId: string,
      scope: Pick<OwnerEndpoint, "environmentId" | "projectId">,
    ) {
      yield* decodeId(taskId);
      yield* decodeId(scope.environmentId);
      yield* decodeId(scope.projectId);
      const rows = yield* sql<Row>`SELECT * FROM task_owner_bindings
      WHERE task_id = ${taskId} AND environment_id = ${scope.environmentId}
      AND project_id = ${scope.projectId} ORDER BY binding_id`;
      return yield* Effect.forEach(rows, fromRow);
    });
    const lookupDurable = Effect.fn("TaskOwnerStore.lookupDurable")(function* (
      taskId: string,
      scope: Pick<OwnerEndpoint, "environmentId" | "projectId">,
    ) {
      const bindings = (yield* history(taskId, scope)).filter((b) => b.revocation === null);
      const threads = new Set(bindings.map((b) => b.threadId));
      const first = bindings[0];
      return {
        status: threads.size > 1 ? "ambiguous" : first ? "bound" : "none",
        owner:
          threads.size === 1 && first
            ? {
                environmentId: first.environmentId,
                projectId: first.projectId,
                threadId: first.threadId,
              }
            : null,
        bindings,
      } satisfies TaskOwnerLookup;
    });
    const bind = Effect.fn("TaskOwnerStore.bind")(function* (input: TaskOwnerBinding) {
      const binding = yield* decodeBinding(input);
      const provenance = yield* decodeProvenance(yield* verifier.verify("bind", binding));
      yield* sql`INSERT INTO task_owner_bindings
      (binding_id, task_id, environment_id, project_id, thread_id, provenance_json)
      VALUES (${binding.bindingId}, ${binding.taskId}, ${binding.environmentId},
      ${binding.projectId}, ${binding.threadId}, ${yield* encodeProvenanceJson(provenance)})
      ON CONFLICT(binding_id) DO NOTHING`;
      const stored = yield* get(binding.bindingId);
      if (
        !stored ||
        stored.taskId !== binding.taskId ||
        stored.environmentId !== binding.environmentId ||
        stored.projectId !== binding.projectId ||
        stored.threadId !== binding.threadId
      )
        return yield* new TaskOwnerStoreError({ reason: "binding-id-conflict" });
      if (stored.revocation) return yield* new TaskOwnerStoreError({ reason: "binding-revoked" });
      return stored;
    });
    const revoke = Effect.fn("TaskOwnerStore.revoke")(function* (bindingId: string) {
      const stored = yield* get(bindingId);
      if (!stored) return yield* new TaskOwnerStoreError({ reason: "binding-missing" });
      const provenance = yield* decodeProvenance(yield* verifier.verify("revoke", stored));
      yield* sql`UPDATE task_owner_bindings SET revocation_json = ${yield* encodeProvenanceJson(provenance)}
      WHERE binding_id = ${bindingId} AND revocation_json IS NULL`;
      return yield* get(bindingId);
    });
    const lookupCurrent = Effect.fn("TaskOwnerStore.lookupCurrent")(function* (
      taskId: string,
      scope: Pick<OwnerEndpoint, "environmentId" | "projectId">,
      shells: readonly CurrentOwnerShell[],
    ) {
      const result = yield* lookupDurable(taskId, scope);
      if (!result.owner) return result;
      const matches = shells.filter(
        (s) =>
          s.environmentId === scope.environmentId &&
          s.projectId === scope.projectId &&
          s.threadId === result.owner!.threadId,
      );
      return matches.length === 1 &&
        matches[0]!.state === "available" &&
        matches[0]!.taskIds.includes(taskId)
        ? result
        : { ...result, status: "unavailable" as const, owner: null };
    });
    return { bind, revoke, unbind: revoke, get, history, lookupDurable, lookupCurrent };
  });
