import * as Schema from "effect/Schema";
import { RuntimeMode } from "./orchestration.ts";

export const ConversationEndpoint = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
});
export const ConversationPrincipal = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("j1"),
    environmentId: Schema.String,
    threadId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("mausbot"),
    environmentId: Schema.String,
    botId: Schema.String,
    threadId: Schema.String,
    generation: Schema.String,
  }),
]);
export type ConversationPrincipal = typeof ConversationPrincipal.Type;

export const ConversationMetadata = Schema.Struct({
  endpoint: ConversationEndpoint,
  title: Schema.String,
  url: Schema.String,
  runtimeMode: RuntimeMode,
  providerInstanceId: Schema.String,
  activeTurnId: Schema.NullOr(Schema.String),
  generation: Schema.optional(Schema.String),
  approvalPending: Schema.Boolean,
  inputPending: Schema.Boolean,
  match: Schema.optional(Schema.Struct({ source: Schema.String, snippet: Schema.String })),
});
export type ConversationMetadata = typeof ConversationMetadata.Type;
export const ConversationMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});
export const ConversationHistoryPage = Schema.Struct({
  conversation: ConversationMetadata,
  messages: Schema.Array(ConversationMessage),
  nextCursor: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
});
export type ConversationHistoryPage = typeof ConversationHistoryPage.Type;
export const ConversationMessagePage = Schema.Struct({
  ...ConversationMessage.fields,
  offset: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
});
export type ConversationMessagePage = typeof ConversationMessagePage.Type;
export const ConversationSearchResult = Schema.Struct({
  conversations: Schema.Array(ConversationMetadata),
  unavailable: Schema.Array(Schema.Struct({ source: Schema.String, reason: Schema.String })),
});
export const ConversationSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)),
});
export const ConversationReadInput = Schema.Struct({
  endpoint: ConversationEndpoint,
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
});
export const ConversationMessageInput = Schema.Struct({
  endpoint: ConversationEndpoint,
  messageId: Schema.String,
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const ConversationCall = Schema.Union([
  Schema.Struct({ action: Schema.Literal("search"), ...ConversationSearchInput.fields }),
  Schema.Struct({ action: Schema.Literal("read"), ...ConversationReadInput.fields }),
  Schema.Struct({ action: Schema.Literal("readMessage"), ...ConversationMessageInput.fields }),
]);
export type ConversationCall = typeof ConversationCall.Type;
export const MausbotConversationInvocation = Schema.Struct({
  botId: Schema.String,
  threadId: Schema.String,
  generation: Schema.String,
  call: ConversationCall,
});

/** Private host requests carry a principal fixed by the invocation boundary, never tool arguments. */
export const ConversationQuery = Schema.Union([
  Schema.Struct({ action: Schema.Literal("inspect"), endpoint: ConversationEndpoint }),
  Schema.Struct({
    action: Schema.Literal("search"),
    principal: ConversationPrincipal,
    query: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("read"),
    principal: ConversationPrincipal,
    endpoint: ConversationEndpoint,
    cursor: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("readMessage"),
    principal: ConversationPrincipal,
    endpoint: ConversationEndpoint,
    messageId: Schema.String,
    offset: Schema.Int,
  }),
]);
export type ConversationQuery = typeof ConversationQuery.Type;
