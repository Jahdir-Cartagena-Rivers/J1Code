import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  type ConversationPrincipal,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Exit } from "effect";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  ExternalConversations,
  makeExternalConversations,
} from "../../../conversations/ExternalConversations.ts";
import { ConversationsToolkit } from "./tools.ts";
import { ConversationsToolkitHandlers } from "./handlers.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("real-source"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session",
  capabilities: new Set(["agents"]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "history-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "history-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
function fixture() {
  const directory = makeExternalConversations();
  const callers: ConversationPrincipal[] = [];
  const native = {
    endpoint: { environmentId: "local", projectId: "mausbot:one", threadId: "mausbot:one:main" },
    title: "A real native conversation",
    url: "/assistants?botId=one&conversation=main",
    runtimeMode: "approval-required" as const,
    providerInstanceId: "codex",
    activeTurnId: null,
    approvalPending: true,
    inputPending: true,
  };
  directory.register({
    kind: "mausbot",
    accepts: (id) => id.startsWith("mausbot:"),
    inspect: () => Effect.succeed(native),
    search: (who) =>
      Effect.sync(() => {
        callers.push(who);
        return [native];
      }),
    read: (who) =>
      Effect.sync(() => {
        callers.push(who);
        return {
          conversation: native,
          messages: [
            { id: "native-message", role: "assistant" as const, text: "Original saved output" },
          ],
          nextCursor: null,
          textTruncated: false,
        };
      }),
    readMessage: (who) =>
      Effect.sync(() => {
        callers.push(who);
        return {
          id: "native-message",
          role: "assistant" as const,
          text: "Original saved output",
          offset: 0,
          nextOffset: null,
        };
      }),
  });
  const layer = McpServer.toolkit(ConversationsToolkit).pipe(
    Layer.provide(ConversationsToolkitHandlers),
    Layer.provide(Layer.succeed(ExternalConversations, directory)),
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
    Effect.gen(function* () {
      return yield* (yield* McpServer.McpServer)
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });
  return { native, callers, layer, call };
}

describe("shared conversation MCP boundary", () => {
  it.effect("returns original engine endpoints and messages with a server-bound speaker", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const search = yield* f.call("search_conversations", { query: "native" });
      expect(search.isError).toBe(false);
      expect(search.structuredContent).toMatchObject({
        conversations: [f.native],
        unavailable: [],
      });
      const history = yield* f.call("read_conversation", { endpoint: f.native.endpoint });
      expect(history.structuredContent).toMatchObject({
        messages: [{ id: "native-message", text: "Original saved output" }],
      });
      const message = yield* f.call("read_conversation_message", {
        endpoint: f.native.endpoint,
        messageId: "native-message",
      });
      expect(message.isError).toBe(false);
      expect(f.callers).toEqual(
        Array.from({ length: 3 }, () => ({
          kind: "j1",
          environmentId: "local",
          threadId: "real-source",
        })),
      );
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("rejects sessions without agents capability before querying any history", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const result = yield* f.call(
        "search_conversations",
        { query: "native" },
        { ...scope, capabilities: new Set() },
      );
      expect(result.isError).toBe(true);
      expect(f.callers).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("rejects another environment and invalid offsets before opening history", () => {
    const f = fixture();
    return Effect.gen(function* () {
      expect(
        (yield* f.call("read_conversation", {
          endpoint: { ...f.native.endpoint, environmentId: "other" },
        })).isError,
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* f
            .call("read_conversation_message", {
              endpoint: f.native.endpoint,
              messageId: "native-message",
              offset: -1,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(f.callers).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  });
});
