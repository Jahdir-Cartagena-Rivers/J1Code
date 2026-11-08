import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { encodeThreadDetailPageCursor } from "../orchestration/threadDetailCursor.ts";
import { makeJ1ConversationSource } from "./J1ConversationSource.ts";

const time = "2026-11-07T12:00:00.000Z";
const principal = { kind: "j1", environmentId: "local", threadId: "speaker" } as const;
const endpoint = { environmentId: "local", projectId: "project", threadId: "thread" };
const message = (id: string, text: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  turnId: null,
  streaming: false,
  createdAt: time,
  updatedAt: time,
});
function shell(archived = false): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread"),
    projectId: ProjectId.make("project"),
    title: "An unrelated title",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: time,
    updatedAt: time,
    archivedAt: archived ? time : null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: time,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}
function fixture(options: { archived?: boolean; foreignMessage?: boolean } = {}) {
  const thread = shell(options.archived);
  const messages = [
    message("large", "x".repeat(17_000)),
    message("answer", "Remember this answer"),
  ];
  const detail: OrchestrationThread = {
    ...thread,
    bot: null,
    deletedAt: null,
    messages,
    activities: [],
    checkpoints: [],
    proposedPlans: [],
  };
  const calls: { search: string[]; detail: number } = { search: [], detail: 0 };
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(id === thread.id ? Option.some(thread) : Option.none()),
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 1, projects: [], threads: [thread], updatedAt: time }),
      searchThreads: (input) =>
        Effect.sync(() => {
          calls.search.push(input.query);
          return {
            matches:
              input.query === "answer"
                ? [
                    {
                      threadId: thread.id,
                      projectId: thread.projectId,
                      source: "assistant" as const,
                      snippet: "Remember this answer",
                      messageCreatedAt: time,
                    },
                  ]
                : [],
          };
        }),
      getThreadDetailSnapshot: () =>
        Effect.sync(() => {
          calls.detail++;
          return Option.some({
            snapshotSequence: 1,
            thread: detail,
            page: { snapshotSequence: 1, hasMore: false, beforeCursor: null },
          });
        }),
    }),
    Layer.mock(ProjectionThreadMessageRepository)({
      getByMessageId: ({ messageId }) => {
        const row = messages.find((message) => message.id === messageId);
        return Effect.succeed(
          row
            ? Option.some({
                messageId: row.id,
                threadId: ThreadId.make(options.foreignMessage ? "other" : "thread"),
                turnId: null,
                role: row.role,
                text: row.text,
                isStreaming: false,
                createdAt: time,
                updatedAt: time,
              })
            : Option.none(),
        );
      },
    }),
  );
  const source = Effect.gen(function* () {
    return makeJ1ConversationSource(
      "local",
      yield* ProjectionSnapshotQuery,
      yield* ProjectionThreadMessageRepository,
    );
  });
  return { layer, source, calls };
}

describe("existing J1 conversation histories", () => {
  it.effect("searches canonical message text and retains title-only matches", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const source = yield* f.source;
      const found = yield* source.search(principal, "answer");
      expect(found[0]?.match).toEqual({ source: "assistant", snippet: "Remember this answer" });
      expect(found[0]?.endpoint).toEqual(endpoint);
      expect((yield* source.search(principal, "unrelated"))[0]?.title).toBe("An unrelated title");
      expect(f.calls.search).toEqual(["answer", "unrelated"]);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("retains message handles after exhausting the text budget", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const source = yield* f.source;
      const page = yield* source.read(principal, endpoint);
      expect(page.textTruncated).toBe(true);
      expect(page.messages.map((message) => message.id)).toEqual(["large", "answer"]);
      expect(page.messages.reduce((sum, message) => sum + message.text.length, 0)).toBe(16_000);
      const tail = yield* source.readMessage(principal, endpoint, "large", 16_000);
      expect(tail.text).toHaveLength(1000);
      expect(tail.nextOffset).toBeNull();
      expect((yield* source.readMessage(principal, endpoint, "answer", 0)).text).toBe(
        "Remember this answer",
      );
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("can read retained archived history without offering it as a routing target", () => {
    const f = fixture({ archived: true });
    return Effect.gen(function* () {
      const source = yield* f.source;
      expect(yield* source.inspect(endpoint)).toBeNull();
      expect((yield* source.read(principal, endpoint)).messages).toHaveLength(2);
      expect((yield* source.readMessage(principal, endpoint, "answer", 0)).text).toContain(
        "answer",
      );
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("rejects foreign cursors, projects and environments before reading a page", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const source = yield* f.source;
      for (const cursor of [
        "malformed",
        encodeThreadDetailPageCursor({
          threadId: ThreadId.make("other"),
          beforeAnchorAt: time,
          beforeTurnId: "turn",
        }),
      ])
        expect(yield* source.read(principal, endpoint, cursor).pipe(Effect.flip)).toBe(
          "Conversation is unavailable.",
        );
      for (const other of [
        { ...endpoint, projectId: "other" },
        { ...endpoint, environmentId: "other" },
      ])
        expect(yield* source.read(principal, other).pipe(Effect.flip)).toBe(
          "Conversation is unavailable.",
        );
      expect(f.calls.detail).toBe(0);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("rejects another thread's message and invalid offsets", () => {
    const f = fixture({ foreignMessage: true });
    return Effect.gen(function* () {
      const source = yield* f.source;
      for (const offset of [0, -1, 0.5, 100_000])
        expect(
          yield* source.readMessage(principal, endpoint, "answer", offset).pipe(Effect.flip),
        ).toBe("Conversation is unavailable.");
    }).pipe(Effect.provide(f.layer));
  });
});
