import {
  CreateDotTaskInput,
  DotIntegrationError,
  ThreadId,
  CommandId,
  type DotConnection,
  type ProjectId,
  type DotTaskResult,
  type DotOAuthScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DotConnections } from "./DotConnections.ts";
import { AgentDelegation, type DotTaskInvocation } from "../mcp/AgentDelegation.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

/** @effect-leakable-service */
export class DotInvocation extends Context.Service<
  DotInvocation,
  { readonly connectionId: string; readonly scopes?: readonly DotOAuthScope[] }
>()("t3/dot/DotService/DotInvocation") {}

const decodeTask = Schema.decodeEffect(CreateDotTaskInput);
const encodeTask = Schema.encodeEffect(Schema.fromJsonString(CreateDotTaskInput));

export const make = Effect.gen(function* () {
  const connections = yield* DotConnections;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const agents = yield* AgentDelegation;
  const registry = yield* ProviderRegistry;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const mutex = yield* Semaphore.make(1);
  const denied = () =>
    new DotIntegrationError({
      message: "This Dot connection has no access to that project or task.",
    });
  const wrap = () =>
    new DotIntegrationError({
      message: "Could not complete the Dot operation. Saved work is preserved.",
    });
  const connection = Effect.flatMap(DotInvocation, ({ connectionId }) =>
    connections.getActive(connectionId),
  );
  const grant = Effect.fn("DotService.grant")(function* (
    projectId: ProjectId,
    operation: "read" | "createTasks",
  ) {
    const principal = yield* connection;
    const invocation = yield* DotInvocation;
    if (
      invocation.scopes &&
      !invocation.scopes.includes(operation === "read" ? "dot:read" : "dot:tasks")
    )
      return yield* denied();
    const access = principal.grants.find((item) => item.projectId === projectId);
    if (!access?.[operation]) return yield* denied();
    const project = yield* snapshots.getProjectShellById(projectId).pipe(Effect.mapError(wrap));
    if (Option.isNone(project)) return yield* denied();
    return { principal, access };
  });
  const scope = (
    principal: DotConnection,
    projectId: ProjectId,
    runtimeMode: DotTaskInvocation["runtimeMode"],
  ): DotTaskInvocation => ({
    kind: "dot",
    connectionId: principal.id,
    projectId,
    runtimeMode,
    threadId: ThreadId.make(`j1-dot:${principal.id}:${projectId}`),
    capabilities: new Set(["agents"]),
  });
  const ownedTask = Effect.fn("DotService.ownedTask")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    // Task inspection is part of task creation permission; broader chat reading is separate.
    const { principal, access } = yield* grant(projectId, "createTasks");
    const rows =
      yield* sql`SELECT thread_id FROM dot_task_requests WHERE connection_id = ${principal.id} AND project_id = ${projectId} AND thread_id = ${threadId}`.pipe(
        Effect.mapError(wrap),
      );
    if (rows.length === 0) return yield* denied();
    return scope(principal, projectId, access.runtimeMode);
  });
  return {
    projects: Effect.gen(function* () {
      const principal = yield* connection;
      const invocation = yield* DotInvocation;
      const projects = yield* snapshots
        .getProjectShells(
          principal.grants
            .filter(
              (item) =>
                (item.read && (!invocation.scopes || invocation.scopes.includes("dot:read"))) ||
                (item.createTasks &&
                  (!invocation.scopes || invocation.scopes.includes("dot:tasks"))),
            )
            .map((item) => item.projectId),
        )
        .pipe(Effect.mapError(wrap));
      return {
        projects: projects.map((project) => ({
          id: project.id,
          title: project.title,
          grant: {
            ...principal.grants.find((item) => item.projectId === project.id)!,
            read:
              principal.grants.find((item) => item.projectId === project.id)!.read &&
              (!invocation.scopes || invocation.scopes.includes("dot:read")),
            createTasks:
              principal.grants.find((item) => item.projectId === project.id)!.createTasks &&
              (!invocation.scopes || invocation.scopes.includes("dot:tasks")),
          },
        })),
      };
    }),
    models: Effect.gen(function* () {
      yield* connection;
      const providers = yield* registry.getProviders;
      return {
        providers: providers.map((provider) => ({
          instanceId: provider.instanceId,
          name: provider.displayName ?? provider.driver,
          available:
            provider.enabled && provider.installed && provider.availability !== "unavailable",
          models: provider.models.map((model) => ({ model: model.slug, name: model.name })),
        })),
      };
    }),
    threads: Effect.fn("DotService.threads")(function* (input: {
      projectId: ProjectId;
      cursor?: string;
      limit?: number;
    }) {
      yield* grant(input.projectId, "read");
      const limit = Math.min(50, Math.max(1, input.limit ?? 20));
      const rows = yield* sql<{ id: string; title: string }>`
        SELECT thread_id AS id, title FROM projection_threads
        WHERE project_id = ${input.projectId} AND deleted_at IS NULL AND archived_at IS NULL
          AND thread_id > ${input.cursor ?? ""}
        ORDER BY thread_id LIMIT ${limit + 1}
      `.pipe(Effect.mapError(wrap));
      const threads = rows
        .slice(0, limit)
        .map((row) => ({ id: row.id, title: row.title.slice(0, 200) }));
      return { threads, nextCursor: rows.length > limit ? threads.at(-1)!.id : null };
    }),
    read: Effect.fn("DotService.read")(function* (input: {
      projectId: ProjectId;
      threadId: ThreadId;
      beforeCursor?: string;
      turnLimit?: number;
    }) {
      yield* grant(input.projectId, "read");
      const shell = yield* snapshots.getThreadShellById(input.threadId).pipe(Effect.mapError(wrap));
      if (Option.isNone(shell) || shell.value.projectId !== input.projectId) return yield* denied();
      const detail = yield* snapshots
        .getThreadDetailSnapshot(input.threadId, {
          turnLimit: Math.min(20, Math.max(1, input.turnLimit ?? 5)),
          ...(input.beforeCursor ? { beforeCursor: input.beforeCursor } : {}),
        })
        .pipe(Effect.mapError(wrap));
      if (Option.isNone(detail)) return yield* denied();
      let remaining = 24_000;
      let truncated = false;
      const messages = detail.value.thread.messages
        .slice(-100)
        .toReversed()
        .map((message) => {
          const text = message.text.slice(0, Math.min(4_000, remaining));
          remaining -= text.length;
          if (text.length < message.text.length) truncated = true;
          return { id: message.id, role: message.role, text };
        })
        .toReversed();
      return {
        threadId: input.threadId,
        title: shell.value.title.slice(0, 200),
        messages,
        page: detail.value.page ?? null,
        contentTruncated: truncated || detail.value.thread.messages.length > 100,
      };
    }),
    create: Effect.fn("DotService.create")(function* (input: CreateDotTaskInput) {
      input = yield* decodeTask(input).pipe(
        Effect.mapError(() => new DotIntegrationError({ message: "Invalid Dot task." })),
      );
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const { principal, access } = yield* grant(input.projectId, "createTasks");
          const invocation = scope(principal, input.projectId, access.runtimeMode);
          const encoded = yield* encodeTask(input).pipe(Effect.mapError(wrap));
          const fingerprint = yield* crypto
            .digest("SHA-256", new TextEncoder().encode(encoded))
            .pipe(
              Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
              Effect.mapError(wrap),
            );
          const candidate = ThreadId.make(
            `j1-agent:${yield* crypto.randomUUIDv4.pipe(Effect.mapError(wrap))}`,
          );
          const reserved = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO dot_task_requests (connection_id, project_id, request_id, fingerprint, thread_id)
            VALUES (${principal.id}, ${input.projectId}, ${input.requestId}, ${fingerprint}, ${candidate})
            ON CONFLICT (connection_id, project_id, request_id) DO NOTHING`;
                const rows = yield* sql<{
                  fingerprint: string;
                  thread_id: string;
                }>`SELECT fingerprint, thread_id FROM dot_task_requests
            WHERE connection_id = ${principal.id} AND project_id = ${input.projectId} AND request_id = ${input.requestId}`;
                const row = rows[0];
                if (!row || row.fingerprint !== fingerprint)
                  return yield* new DotIntegrationError({
                    message: "This requestId was already used for a different Dot task.",
                  });
                return ThreadId.make(row.thread_id);
              }),
            )
            .pipe(Effect.catchTag("SqlError", wrap));
          const existing = yield* snapshots
            .getThreadShellById(invocation.threadId)
            .pipe(Effect.mapError(wrap));
          if (Option.isNone(existing)) {
            yield* engine
              .dispatch({
                type: "thread.create",
                commandId: CommandId.make(`dot-coordinator:${invocation.threadId}`),
                threadId: invocation.threadId,
                projectId: input.projectId,
                title: `Dot: ${principal.label}`,
                modelSelection: input.modelSelection,
                runtimeMode: access.runtimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: DateTime.formatIso(yield* DateTime.now),
              })
              .pipe(Effect.mapError(wrap));
          }
          // This is a saved coordinator chat, not a running or fabricated provider session.
          return yield* agents
            .spawn(input, { ...invocation, taskThreadId: reserved })
            .pipe(Effect.mapError((error) => new DotIntegrationError({ message: error.message })));
        }),
      );
    }),
    get: Effect.fn("DotService.get")(function* (
      projectId: ProjectId,
      threadId: ThreadId,
      beforeCursor?: string,
    ): Effect.fn.Return<DotTaskResult, DotIntegrationError, DotInvocation> {
      const invocation = yield* ownedTask(projectId, threadId);
      const result = yield* agents
        .get(threadId, invocation)
        .pipe(Effect.mapError((error) => new DotIntegrationError({ message: error.message })));
      const detail = yield* snapshots
        .getThreadDetailSnapshot(threadId, {
          turnLimit: 1,
          ...(beforeCursor ? { beforeCursor } : {}),
        })
        .pipe(Effect.mapError(wrap));
      if (Option.isNone(detail)) return yield* denied();
      const text = detail.value.thread.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .join("\n\n");
      return {
        ...result,
        output: text.slice(-8_000),
        outputTruncated: text.length > 8_000 || detail.value.page?.hasMore === true,
        page: detail.value.page ?? null,
      };
    }),
    cancel: Effect.fn("DotService.cancel")(function* (projectId: ProjectId, threadId: ThreadId) {
      const invocation = yield* ownedTask(projectId, threadId);
      return yield* agents
        .cancel(threadId, invocation)
        .pipe(Effect.mapError((error) => new DotIntegrationError({ message: error.message })));
    }),
  };
});

/** @effect-expect-leaking DotInvocation */
export class DotService extends Context.Service<DotService, Effect.Success<typeof make>>()(
  "t3/dot/DotService",
) {}
export const layer = Layer.effect(DotService, make);
