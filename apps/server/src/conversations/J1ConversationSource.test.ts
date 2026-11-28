import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { ExternalConversations } from "./ExternalConversations.ts";
import { ExternalConversationsLive } from "./live.ts";

const timestamp = "2026-11-07T12:00:00.000Z";
const time = DateTime.makeUnsafe(timestamp);
const unavailable = "Conversation is unavailable.";
const principal = { kind: "j1", environmentId: "local", threadId: "speaker" } as const;
const endpoint = { environmentId: "local", projectId: "project", threadId: "thread" };
const threadId = ThreadId.make(endpoint.threadId);
const neighborId = ThreadId.make("ordinary-neighbor");
const botId = ThreadId.make("j1-mausbot:some-bot:conversation-1");
const roomId = ThreadId.make("j1-mausbot:room:group:room-task:member");
const shell = (
  id: ThreadId,
  title: string,
  project = endpoint.projectId,
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(id, { runtimeMode: "full-access" }),
  id,
  title,
  projectId: ProjectId.make(project),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  activeRunId: null,
  pendingRuntimeRequest: null,
  updatedAt: time,
  archivedAt: null,
  deletedAt: null,
});
const message = (
  id: string,
  text: string,
  role: "user" | "assistant",
  owner = threadId,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId: owner,
  role,
  text,
  createdBy: role === "user" ? "user" : "agent",
  creationSource: role === "user" ? "web" : "provider",
  runId: null,
  nodeId: null,
  attachments: [],
  streaming: false,
  createdAt: time,
  updatedAt: time,
});
function item(
  row: ReturnType<typeof message>,
  position: number,
  visibility: "local" | "inherited" = "local",
) {
  return {
    position,
    visibility,
    sourceThreadId: row.threadId,
    sourceItemId: TurnItemId.make(`item:${row.id}`),
    item: {
      type: row.role === "user" ? "user_message" : "assistant_message",
      messageId: row.id,
    },
  } as OrchestrationV2ProjectedTurnItem;
}

function fixture(
  options: {
    archived?: boolean;
    deleted?: boolean;
    foreignMessage?: boolean;
    archiveDuringRead?: boolean;
  } = {},
) {
  const thread = {
    ...shell(threadId, "An unrelated title"),
    activeRunId: RunId.make("active-run"),
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request"),
      kind: "user_input",
      createdAt: time,
    },
    archivedAt: options.archived ? time : null,
    deletedAt: options.deleted ? time : null,
  } satisfies OrchestrationV2ThreadShell;
  const neighbor = shell(neighborId, "Neighbor title", "neighbor-project");
  const bot = shell(botId, "Bot title");
  const room = shell(roomId, "Room member");
  const large = message("large", "x".repeat(17_000), "user");
  const answer = message("answer", "Remember this answer", "assistant");
  const older = message("older", "Earlier prompt", "user");
  const foreign = message("foreign", "Other project text", "assistant", neighborId);
  const messages = [older, large, answer, foreign];
  const calls = {
    search: [] as string[],
    pages: [] as number[],
    lookups: [] as ReadonlyArray<MessageId>[],
  };
  let archived = false;
  const layer = ExternalConversationsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerEnvironmentIdentity)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
        }),
        Layer.mock(ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.sync(() => {
              const row = [thread, neighbor, bot, room].find((row) => row.id === id);
              if (row === undefined) return null;
              return archived && id === threadId ? { ...row, archivedAt: time } : row;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [thread, neighbor, bot, room],
              archivedThreads: [],
            }),
          getTimelinePage: (id, input) =>
            Effect.sync(() => {
              expect(id).toBe(threadId);
              expect(input.view).toBe("messages");
              expect(input.limit).toBe(40);
              const position = input.beforePosition ?? -1;
              calls.pages.push(position);
              return {
                items:
                  position === 2
                    ? [item(older, 0)]
                    : [
                        item(large, 2),
                        item(foreign, 3, "inherited"),
                        item(answer, 4),
                        item(answer, 5),
                      ],
                totalItems: 6,
                hasMore: false,
                hasEarlier: position !== 2,
              };
            }),
          getMessagesById: (id, ids) =>
            Effect.sync(() => {
              expect(id).toBe(threadId);
              calls.lookups.push(ids);
              archived ||= options.archiveDuringRead === true;
              return new Map(
                messages
                  .filter((row) => ids.includes(row.id))
                  .map((row) => [
                    row.id,
                    options.foreignMessage ? { ...row, threadId: neighborId } : row,
                  ]),
              );
            }),
        }),
        Layer.mock(ThreadSearch)({
          search: (input) =>
            Effect.sync(() => {
              calls.search.push(input.query);
              expect(input.limit).toBe(50);
              return {
                matches:
                  input.query === "answer"
                    ? [
                        {
                          threadId,
                          projectId: thread.projectId,
                          source: "assistant" as const,
                          snippet: "Remember this answer",
                          messageCreatedAt: timestamp,
                        },
                      ]
                    : [],
              };
            }),
        }),
      ),
    ),
  );
  return { layer, calls };
}

describe("V2 J1 conversations", () => {
  it.effect(
    "registers current search results, preserves ordinary neighbors and the bot URL",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const source = yield* ExternalConversations;
        const found = yield* source.search(principal, "answer");
        expect(found.conversations[0]).toMatchObject({
          endpoint,
          activeTurnId: "active-run",
          inputPending: true,
          approvalPending: false,
          match: { source: "assistant", snippet: "Remember this answer" },
        });
        expect((yield* source.search(principal, "unrelated")).conversations[0]?.title).toBe(
          "An unrelated title",
        );
        expect(
          (yield* source.search(principal, "")).conversations.map(
            ({ endpoint }) => endpoint.threadId,
          ),
        ).toEqual([threadId, neighborId]);
        const bot = yield* source.inspect({ ...endpoint, threadId: botId });
        expect(bot?.url).toBe(
          "/assistants?environmentId=local&botId=some-bot&conversation=conversation-1",
        );
        const room = yield* source.inspect({ ...endpoint, threadId: roomId });
        expect(room?.url).toBe(`/local/${encodeURIComponent(roomId)}`);
        expect(f.calls.search).toEqual(["answer", "unrelated"]);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("pages local message identities and bounds the page and individual reads", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const source = yield* ExternalConversations;
      const page = yield* source.read(principal, endpoint);
      expect(page.textTruncated).toBe(true);
      expect(page.messages.map(({ id, role }) => [id, role])).toEqual([
        ["large", "user"],
        ["answer", "assistant"],
      ]);
      expect(page.messages[0]?.text).toHaveLength(16_000);
      expect(page.messages[1]?.text).toBe("");
      expect(page.nextCursor).toBeTruthy();
      const earlier = yield* source.read(principal, endpoint, page.nextCursor ?? undefined);
      expect(earlier.messages.map(({ id }) => id)).toEqual(["older"]);
      expect(earlier.nextCursor).toBeNull();
      expect(f.calls.pages).toEqual([Infinity, 2]);
      expect(f.calls.lookups).toEqual([["large", "answer"], ["older"]]);
      const first = yield* source.readMessage(principal, endpoint, "large", 0);
      expect(first.text).toHaveLength(8_000);
      expect(first.nextOffset).toBe(8_000);
      const tail = yield* source.readMessage(principal, endpoint, "large", 16_000);
      expect(tail.text).toHaveLength(1000);
      expect(tail.nextOffset).toBeNull();
      expect((yield* source.readMessage(principal, endpoint, "answer", 0)).text).toBe(
        "Remember this answer",
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects invalid scope, cursors and offsets before reading history", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const source = yield* ExternalConversations;
      const token = (project: string, thread: string) =>
        Buffer.from(JSON.stringify(["j1-v2", "local", project, thread, 2])).toString("base64url");
      for (const cursor of [
        "",
        "malformed",
        "a".repeat(2049),
        token("other", "thread"),
        token("project", "other"),
      ]) {
        expect(yield* source.read(principal, endpoint, cursor).pipe(Effect.flip)).toBe(unavailable);
      }
      for (const target of [
        { ...endpoint, projectId: "other" },
        { ...endpoint, environmentId: "other" },
      ])
        expect(yield* source.read(principal, target).pipe(Effect.flip)).toContain("unavailable");
      expect(
        yield* source
          .read({ ...principal, environmentId: "elsewhere" }, endpoint)
          .pipe(Effect.flip),
      ).toContain("unavailable");
      for (const offset of [-1, 0.5, Number.POSITIVE_INFINITY]) {
        expect(
          yield* source.readMessage(principal, endpoint, "answer", offset).pipe(Effect.flip),
        ).toBe(unavailable);
      }
      expect(f.calls.pages).toEqual([]);
      expect(f.calls.lookups).toEqual([]);
      expect(
        yield* source.readMessage(principal, endpoint, "answer", 100_000).pipe(Effect.flip),
      ).toBe(unavailable);
      expect(yield* source.readMessage(principal, endpoint, "foreign", 0).pipe(Effect.flip)).toBe(
        unavailable,
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("keeps archived history readable without offering it as a destination", () => {
    const f = fixture({ archived: true });
    return Effect.gen(function* () {
      const source = yield* ExternalConversations;
      expect(yield* source.inspect(endpoint)).toBeNull();
      expect((yield* source.search(principal, "answer")).conversations).toEqual([]);
      expect((yield* source.read(principal, endpoint)).messages.map(({ id }) => id)).toEqual([
        "large",
        "answer",
      ]);
      expect((yield* source.readMessage(principal, endpoint, "answer", 0)).text).toBe(
        "Remember this answer",
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect.each([{ deleted: true }, { archiveDuringRead: true }])(
    "refuses history for a deleted thread or one archived during the read ($deleted $archiveDuringRead)",
    (options) => {
      const pageFixture = fixture(options);
      const messageFixture = fixture(options);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const source = yield* ExternalConversations;
          if (!("archiveDuringRead" in options)) expect(yield* source.inspect(endpoint)).toBeNull();
          expect(yield* source.read(principal, endpoint).pipe(Effect.flip)).toBe(unavailable);
          expect(pageFixture.calls.pages.length).toBe("archiveDuringRead" in options ? 1 : 0);
        }).pipe(Effect.provide(pageFixture.layer));
        yield* Effect.gen(function* () {
          const source = yield* ExternalConversations;
          expect(
            yield* source.readMessage(principal, endpoint, "answer", 0).pipe(Effect.flip),
          ).toBe(unavailable);
        }).pipe(Effect.provide(messageFixture.layer));
      });
    },
  );
});
