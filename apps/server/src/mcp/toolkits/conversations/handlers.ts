import { Effect } from "effect";
import { ExternalConversations } from "../../../conversations/ExternalConversations.ts";
import { nativeAgentCaller } from "../routing/boundary.ts";
import { ConversationsToolkit } from "./tools.ts";

export const conversationPrincipal = nativeAgentCaller.pipe(
  Effect.map(({ scope }) => ({
    kind: "j1" as const,
    environmentId: scope.environmentId,
    threadId: scope.thread.threadId,
  })),
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
