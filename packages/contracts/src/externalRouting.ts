import * as Schema from "effect/Schema";
import { RuntimeMode } from "./orchestration.ts";
import { ConversationEndpoint, ConversationPrincipal } from "./conversation.ts";

/** Private adapter facts, re-read by the serialized command admission boundary. */
export const ExternalRouteSourceSnapshot = Schema.Struct({
  endpoint: ConversationEndpoint,
  url: Schema.String,
  runtimeMode: RuntimeMode,
  providerKey: Schema.String,
  permissionsKnown: Schema.Boolean,
  archived: Schema.Boolean,
  activeGeneration: Schema.optionalKey(Schema.NullOr(Schema.String)),
  canSteer: Schema.optionalKey(Schema.Boolean),
  blocked: Schema.optionalKey(Schema.Boolean),
});
export type ExternalRouteSourceSnapshot = typeof ExternalRouteSourceSnapshot.Type;
export const ExternalRouteDelivery = Schema.Struct({
  requestId: Schema.String,
  fingerprint: Schema.String,
  attemptId: Schema.String,
  source: ConversationEndpoint,
  destination: ConversationEndpoint,
  content: Schema.String,
  permissionCeiling: Schema.Array(Schema.String),
  visited: Schema.Array(ConversationEndpoint),
  expectedGeneration: Schema.NullOr(Schema.String),
});
export type ExternalRouteDelivery = typeof ExternalRouteDelivery.Type;
export const ExternalRouteReceiptKey = Schema.Struct({
  requestId: Schema.String,
  fingerprint: Schema.String,
  attemptId: Schema.String,
  destination: ConversationEndpoint,
});
export type ExternalRouteReceiptKey = typeof ExternalRouteReceiptKey.Type;
export const ExternalRouteTransportProof = Schema.Struct({
  generation: Schema.String,
  providerTurnId: Schema.String,
});
export type ExternalRouteTransportProof = typeof ExternalRouteTransportProof.Type;
export const ExternalRouteDeliveryResult = Schema.Literals([
  "rejected",
  "admitted",
  "delivered",
  "uncertain",
]);
export type ExternalRouteDeliveryResult = typeof ExternalRouteDeliveryResult.Type;
export const ExternalRouteHostEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("routingWake") }),
  Schema.Struct({ kind: Schema.Literal("routeSourceCheck"), delivery: ExternalRouteDelivery }),
  Schema.Struct({
    kind: Schema.Literal("routeTransport"),
    delivery: ExternalRouteDelivery,
    generation: Schema.String,
    providerTurnId: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("routeFailed"), delivery: ExternalRouteDelivery }),
]);
export type ExternalRouteHostEvent = typeof ExternalRouteHostEvent.Type;
export const ExternalRouteNotice = Schema.Struct({
  endpoint: ConversationEndpoint,
  requestId: Schema.String,
  revision: Schema.Int,
  status: Schema.String,
  summary: Schema.String,
});
export type ExternalRouteNotice = typeof ExternalRouteNotice.Type;

export const MausbotRoutingInvocation = Schema.Struct({
  kind: Schema.Literal("routing"),
  botId: Schema.String,
  threadId: Schema.String,
  generation: Schema.String,
  operation: Schema.Literals([
    "list_chat_projects",
    "routing_mode",
    "claim_task",
    "release_task",
    "route_task",
    "routing_status",
    "list_routes",
    "acknowledge_route",
  ]),
  arguments: Schema.Unknown,
});
export type MausbotRoutingInvocation = typeof MausbotRoutingInvocation.Type;
export type ExternalRoutingActor = typeof ConversationPrincipal.Type;
