import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";
import { DotIntegrationError } from "@t3tools/contracts";
import { DotChat, DotEventSubscribe, DotEventUnsubscribe, DOT_CHAT_EVENT } from "./DotChat.ts";
import { DotToolkit } from "./tools.ts";
import { DotInvocation, DotService } from "./DotService.ts";
import { DotHiveMind } from "./DotHiveMind.ts";
import { DotConnections } from "./DotConnections.ts";

export const RpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export const discovery = {
  resultType: "complete",
  supportedVersions: ["2026-07-28", "2025-06-18"],
  capabilities: { tools: {}, events: {} },
};
const Call = Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Unknown) });
const decodeSubscribe = Schema.decodeUnknownEffect(DotEventSubscribe);
const decodeUnsubscribe = Schema.decodeUnknownEffect(DotEventUnsubscribe);
const decodeCall = Schema.decodeUnknownEffect(Call);
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isIntegrationError = Schema.is(DotIntegrationError);

// Effect's current MCP adapter is sessionful. MCP 2 requests execute the SAME toolkit
// directly, so existing permission checks stay shared without inventing legacy sessions.
export const make = Effect.gen(function* () {
  const built = yield* DotToolkit;
  const chat = yield* DotChat;
  const dot = yield* DotService;
  const hiveMind = yield* DotHiveMind;
  const connections = yield* DotConnections;
  const toolList = Object.values(built.tools).map((tool) => {
    const meta = Context.getOrUndefined(tool.annotations, Tool.Meta);
    return {
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
      ...(meta
        ? {
            _meta: meta,
            ...(meta.securitySchemes ? { securitySchemes: meta.securitySchemes } : {}),
          }
        : {}),
    };
  });
  const hasTool = (name: string): name is keyof typeof built.tools =>
    Object.hasOwn(built.tools, name);
  return (input: typeof RpcRequest.Type) =>
    Effect.gen(function* () {
      let result: unknown;
      switch (input.method) {
        case "server/discover":
          result = discovery;
          break;
        case "tools/list":
          result = { tools: toolList };
          break;
        case "events/list": {
          const invocation = yield* DotInvocation;
          const connection = yield* connections.getActive(invocation.connectionId);
          result = {
            events:
              connection.chat && invocation.scopes?.includes("dot:chat")
                ? [
                    {
                      name: DOT_CHAT_EVENT,
                      description:
                        "A user message awaiting a reply in this connection's native J1 Dot chat, including bounded reminders for unanswered messages. For every event, read_dot_chat with pendingOnly=true, answer each pending message using post_dot_reply, and verify no pending messages remain. Ordinary conversation does not require workers.",
                      delivery: ["webhook"],
                      inputSchema: {
                        type: "object",
                        properties: {
                          connectionId: { type: "string" },
                        },
                        required: ["connectionId"],
                        additionalProperties: false,
                      },
                      payloadSchema: {
                        type: "object",
                        properties: {
                          connectionId: { type: "string" },
                          messageId: { type: "string" },
                          text: { type: "string" },
                        },
                        required: ["connectionId", "messageId", "text"],
                        additionalProperties: false,
                      },
                    },
                  ]
                : [],
          };
          break;
        }
        case "events/subscribe":
          result = yield* chat.subscribe(yield* decodeSubscribe(input.params));
          break;
        case "events/unsubscribe":
          yield* chat.unsubscribe(yield* decodeUnsubscribe(input.params));
          result = {};
          break;
        case "tools/call": {
          const call = yield* decodeCall(input.params);
          if (!hasTool(call.name))
            return {
              jsonrpc: "2.0",
              id: input.id,
              error: { code: -32601, message: "Unknown Dot tool." },
            };
          // The toolkit decodes this wire value with the selected tool's parameter schema.
          const last = yield* built
            .handle(
              call.name,
              (call.arguments ?? {}) as Tool.ParametersEncoded<
                (typeof built.tools)[typeof call.name]
              >,
            )
            .pipe(
              Stream.unwrap,
              Stream.runLast,
              Effect.provideService(DotService, dot),
              Effect.provideService(DotHiveMind, hiveMind),
              Effect.provideService(DotChat, chat),
              Effect.mapError((error) =>
                isIntegrationError(error)
                  ? error
                  : new DotIntegrationError({
                      message: "Invalid Dot tool arguments or unavailable tool.",
                    }),
              ),
            );
          const value = Option.isSome(last) ? last.value.encodedResult : {};
          const text = yield* encodeResult(value);
          result = { content: [{ type: "text", text }], structuredContent: value };
          break;
        }
        case "ping":
          result = {};
          break;
        default:
          return {
            jsonrpc: "2.0",
            id: input.id,
            error: { code: -32601, message: "Unknown MCP method." },
          };
      }
      return { jsonrpc: "2.0", id: input.id, result };
    }).pipe(
      Effect.catch((error) => {
        const message = isIntegrationError(error) ? error.message : "Invalid MCP request.";
        const reason =
          input.method !== "events/subscribe"
            ? null
            : message === "ChatGPT callback verification failed."
              ? "challenge_failed"
              : message === "ChatGPT callback could not be reached or verified."
                ? "connection_failed"
                : message === "Invalid ChatGPT callback or signing key."
                  ? "invalid_callback"
                  : null;
        return Effect.logWarning("Dot MCP request rejected", {
          method: input.method,
          reason: reason ?? message,
        }).pipe(
          Effect.as({
            jsonrpc: "2.0",
            id: input.id,
            error: {
              code: reason ? -32015 : -32602,
              message,
              ...(reason ? { data: { reason } } : {}),
            },
          }),
        );
      }),
    );
});
