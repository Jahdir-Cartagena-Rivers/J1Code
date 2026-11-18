import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { BotToolkit } from "./tools.ts";
import { BotToolkitHandlers } from "./handlers.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Keep native screenshots as image blocks and native denials as tool errors. */
export function botToolResult(encoded: unknown): McpSchema.CallToolResult {
  const result = object(encoded) ? encoded.result : undefined;
  if (!object(result) || typeof result.text !== "string" || typeof result.ok !== "boolean") {
    return new McpSchema.CallToolResult({
      content: [{ type: "text", text: JSON.stringify(encoded) }],
      ...(object(encoded) ? { structuredContent: encoded } : {}),
    });
  }
  const images: Array<{ type: "image"; data: Uint8Array; mimeType: string }> = [];
  let encodedBytes = 0;
  for (const image of Array.isArray(result.images) ? result.images : []) {
    const url = object(image) && object(image.image_url) ? image.image_url.url : undefined;
    const match =
      typeof url === "string"
        ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/u.exec(url)
        : null;
    if (!match || images.length >= 10 || (encodedBytes += match[2]!.length) > 32 * 1024 * 1024) {
      return new McpSchema.CallToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: "The bot tool returned an unsupported or oversized image. The operation may already have run; inspect its state before retrying.",
          },
        ],
      });
    }
    images.push({
      type: "image",
      mimeType: match[1]!,
      data: new Uint8Array(Buffer.from(match[2]!, "base64")),
    });
  }
  return new McpSchema.CallToolResult({
    isError: !result.ok,
    structuredContent: { ok: result.ok, text: result.text },
    content: [{ type: "text", text: result.text }, ...images],
  });
}

const registration = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const built = yield* BotToolkit;
    for (const tool of Object.values(BotToolkit.tools)) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: Tool.getJsonSchema(tool),
        }),
        annotations: tool.annotations,
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(fiber.context, McpInvocationContext);
            const call =
              tool.name === "bot_call"
                ? built
                    .handle(
                      "bot_call",
                      payload as Tool.Parameters<typeof BotToolkit.tools.bot_call>,
                    )
                    .pipe(
                      Stream.unwrap,
                      Stream.run(Sink.last()),
                      Effect.flatMap(Effect.fromOption),
                      Effect.map(({ encodedResult }) => encodedResult as unknown),
                    )
                : built
                    .handle(
                      "bot_tools",
                      payload as Tool.Parameters<typeof BotToolkit.tools.bot_tools>,
                    )
                    .pipe(
                      Stream.unwrap,
                      Stream.run(Sink.last()),
                      Effect.flatMap(Effect.fromOption),
                      Effect.map(({ encodedResult }) => encodedResult as unknown),
                    );
            return call.pipe(
              Effect.provideService(McpInvocationContext, invocation),
              Effect.matchCause({
                onFailure: () =>
                  new McpSchema.CallToolResult({
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: "This bot tool is unavailable, denied, cancelled, or its turn ended.",
                      },
                    ],
                  }),
                onSuccess: botToolResult,
              }),
            );
          }),
      });
    }
  }),
);
export const BotToolkitRegistration = registration.pipe(Layer.provide(BotToolkitHandlers));
