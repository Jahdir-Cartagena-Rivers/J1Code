import { Context, Effect, Layer } from "effect";
import type {
  ConversationMetadata,
  ConversationHistoryPage,
  ConversationMessagePage,
  ConversationPrincipal,
} from "@t3tools/contracts";
import type { RouteEndpoint } from "../routing/routeState.ts";

export type ExternalConversation = ConversationMetadata;
export type ConversationPage = ConversationHistoryPage;
export type { ConversationMessagePage, ConversationPrincipal };

/** A source owns its real histories and admission. Registration never creates a mirror chat. */
export interface ExternalConversationSource {
  readonly kind: string;
  readonly accepts: (threadId: string) => boolean;
  readonly inspect: (endpoint: RouteEndpoint) => Effect.Effect<ExternalConversation | null, string>;
  readonly search: (
    principal: ConversationPrincipal,
    query: string,
  ) => Effect.Effect<readonly ExternalConversation[], string>;
  readonly read: (
    principal: ConversationPrincipal,
    endpoint: RouteEndpoint,
    cursor?: string,
  ) => Effect.Effect<ConversationPage, string>;
  readonly readMessage: (
    principal: ConversationPrincipal,
    endpoint: RouteEndpoint,
    messageId: string,
    offset: number,
  ) => Effect.Effect<ConversationMessagePage, string>;
}

export const makeExternalConversations = () => {
  const sources = new Map<string, ExternalConversationSource>();
  const sourceFor = (endpoint: RouteEndpoint) =>
    [...sources.values()].find((source) => source.accepts(endpoint.threadId));
  return {
    register: (source: ExternalConversationSource) => {
      if (sources.has(source.kind)) throw new Error("Conversation source is already registered.");
      sources.set(source.kind, source);
      return () => {
        if (sources.get(source.kind) === source) sources.delete(source.kind);
      };
    },
    inspect: (endpoint: RouteEndpoint) =>
      sourceFor(endpoint)?.inspect(endpoint) ?? Effect.succeed(null),
    read: (principal: ConversationPrincipal, endpoint: RouteEndpoint, cursor?: string) =>
      principal.environmentId !== endpoint.environmentId
        ? Effect.fail("Conversation source is unavailable.")
        : (sourceFor(endpoint)?.read(principal, endpoint, cursor) ??
          Effect.fail("Conversation source is unavailable.")),
    search: (principal: ConversationPrincipal, query: string) =>
      Effect.forEach(
        [...sources.values()],
        (source) =>
          source.search(principal, query).pipe(
            Effect.match({
              onSuccess: (conversations) => ({
                conversations: conversations.filter(
                  (row) => row.endpoint.environmentId === principal.environmentId,
                ),
                unavailable: [] as { source: string; reason: string }[],
              }),
              onFailure: (reason) => ({
                conversations: [] as ExternalConversation[],
                unavailable: [{ source: source.kind, reason }],
              }),
            }),
          ),
        { concurrency: 2 },
      ).pipe(
        Effect.map((pages) => ({
          conversations: pages.flatMap((page) => page.conversations),
          unavailable: pages.flatMap((page) => page.unavailable),
        })),
      ),
    readMessage: (
      principal: ConversationPrincipal,
      endpoint: RouteEndpoint,
      messageId: string,
      offset: number,
    ) =>
      principal.environmentId !== endpoint.environmentId
        ? Effect.fail("Conversation source is unavailable.")
        : (sourceFor(endpoint)?.readMessage(principal, endpoint, messageId, offset) ??
          Effect.fail("Conversation source is unavailable.")),
  };
};

export class ExternalConversations extends Context.Service<
  ExternalConversations,
  ReturnType<typeof makeExternalConversations>
>()("t3/conversations/ExternalConversations") {
  static readonly layer = Layer.sync(ExternalConversations, makeExternalConversations);
}
