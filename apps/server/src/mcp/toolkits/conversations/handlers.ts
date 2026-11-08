import { Effect } from "effect";
import { ExternalConversations } from "../../../conversations/ExternalConversations.ts";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { ConversationsToolkit } from "./tools.ts";

export const conversationPrincipal = requireMcpCapability("agents").pipe(
  Effect.map((scope) => ({
    kind: "j1" as const,
    environmentId: scope.environmentId,
    threadId: scope.threadId,
  })),
  Effect.mapError(() => "Shared conversations are unavailable for this session."),
);
export const ConversationsToolkitHandlers = ConversationsToolkit.toLayer(
  Effect.gen(function* () {
    const directory = yield* ExternalConversations;
    return ConversationsToolkit.of({
      search_conversations: (input) =>
        conversationPrincipal.pipe(Effect.flatMap((who) => directory.search(who, input.query))),
      read_conversation: (input) =>
        conversationPrincipal.pipe(
          Effect.flatMap((who) => directory.read(who, input.endpoint, input.cursor)),
        ),
      read_conversation_message: (input) =>
        conversationPrincipal.pipe(
          Effect.flatMap((who) =>
            directory.readMessage(who, input.endpoint, input.messageId, input.offset ?? 0),
          ),
        ),
    });
  }),
);
