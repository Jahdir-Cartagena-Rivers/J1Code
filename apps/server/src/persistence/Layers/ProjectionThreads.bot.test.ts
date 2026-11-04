import { BotId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionThread, ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const decodeThread = Schema.decodeSync(ProjectionThread);
const row = (id: string, bot?: ProjectionThread["bot"]) =>
  decodeThread({
    threadId: ThreadId.make(id),
    projectId: ProjectId.make("garden"),
    title: "Garden work",
    bot: bot ?? null,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurnId: null,
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    latestUserMessageAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: null,
  });

layer("conversation bot persistence", (it) => {
  it.effect("retains identity and instructions across unrelated projection updates", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const bot = {
        id: BotId.make("garden-helper"),
        name: "Garden helper",
        instructions: "Use the supplied records.",
      };
      const original = row("bot-conversation", bot);
      yield* repository.upsert(original);
      const loaded = yield* repository.getById({ threadId: original.threadId });
      assert.isTrue(Option.isSome(loaded));
      if (Option.isNone(loaded)) return;
      yield* repository.upsert({ ...loaded.value, title: "Renamed conversation" });
      const updated = yield* repository.getById({ threadId: original.threadId });
      assert.deepEqual(Option.getOrThrow(updated).bot, bot);
      assert.equal(Option.getOrThrow(updated).runtimeMode, "approval-required");
    }),
  );

  it.effect("reads older non-bot conversations without inventing an identity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const original = row("ordinary-conversation");
      yield* repository.upsert(original);
      assert.isNull(
        Option.getOrThrow(yield* repository.getById({ threadId: original.threadId })).bot,
      );
    }),
  );

  it.effect("rejects malformed stored identity instead of silently discarding it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const original = row("invalid-bot-conversation");
      yield* repository.upsert(original);
      yield* sql`UPDATE projection_threads SET bot_identity_json = '{"id":42}' WHERE thread_id = ${original.threadId}`;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(repository.getById({ threadId: original.threadId }))),
      );
    }),
  );
});
