import {
  ConversationMetadata,
  ConversationHistoryPage,
  ConversationMessagePage,
  type ConversationQuery,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import type { ExternalConversationSource } from "./ExternalConversations.ts";

export function makeMausbotConversationSource(
  environmentId: string,
  query: (input: ConversationQuery) => Effect.Effect<unknown, string>,
): ExternalConversationSource {
  const sameEnvironment = (id: string) => id === environmentId;
  const unavailable = () => "Conversation source is unavailable.";
  const sameEndpoint = (
    a: { environmentId: string; projectId: string; threadId: string },
    b: typeof a,
  ) =>
    a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId;
  return {
    kind: "mausbot",
    accepts: (id) => id.startsWith("mausbot:"),
    inspect: (endpoint) =>
      sameEnvironment(endpoint.environmentId)
        ? query({ action: "inspect", endpoint }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.NullOr(ConversationMetadata))),
            Effect.filterOrFail(
              (value) => value === null || sameEndpoint(value.endpoint, endpoint),
              unavailable,
            ),
            Effect.mapError(unavailable),
          )
        : Effect.succeed(null),
    search: (principal, text) =>
      sameEnvironment(principal.environmentId)
        ? query({ action: "search", principal, query: text }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConversationMetadata))),
            Effect.mapError(unavailable),
          )
        : Effect.fail(unavailable()),
    read: (principal, endpoint, cursor) =>
      sameEnvironment(principal.environmentId) && sameEnvironment(endpoint.environmentId)
        ? query({ action: "read", principal, endpoint, ...(cursor ? { cursor } : {}) }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ConversationHistoryPage)),
            Effect.filterOrFail(
              (value) => sameEndpoint(value.conversation.endpoint, endpoint),
              unavailable,
            ),
            Effect.mapError(unavailable),
          )
        : Effect.fail(unavailable()),
    readMessage: (principal, endpoint, messageId, offset) =>
      sameEnvironment(principal.environmentId) && sameEnvironment(endpoint.environmentId)
        ? query({ action: "readMessage", principal, endpoint, messageId, offset }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ConversationMessagePage)),
            Effect.filterOrFail(
              (value) => value.id === messageId && value.offset === offset,
              unavailable,
            ),
            Effect.mapError(unavailable),
          )
        : Effect.fail(unavailable()),
  };
}
