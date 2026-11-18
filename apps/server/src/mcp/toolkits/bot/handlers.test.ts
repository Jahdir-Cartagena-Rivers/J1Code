import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer, McpSchema } from "effect/unstable/ai";
import { registerBotExecutionContext } from "../../../mausbot/ExecutionContext.ts";
import { McpInvocationContext, requireMcpCapability } from "../../McpInvocationContext.ts";
import { BotToolkitRegistration, botToolResult } from "./register.ts";

const threadId = ThreadId.make("bot-tool-owner");
const invocation = {
  environmentId: EnvironmentId.make("fixture"),
  threadId,
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["agents"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "fixture", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const testLayer = BotToolkitRegistration.pipe(Layer.provideMerge(McpServer.McpServer.layer));

it("retains actual image bytes and denial status instead of burying them in JSON", () => {
  const screenshot = botToolResult({
    result: {
      ok: true,
      text: "Screenshot",
      images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }],
    },
  });
  expect(screenshot.content[1]).toMatchObject({
    type: "image",
    data: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
  });
  expect(botToolResult({ result: { ok: false, text: "Denied" } }).isError).toBe(true);
  expect(
    botToolResult({
      result: {
        ok: true,
        text: "Already ran",
        images: [{ image_url: { url: "https://untrusted.invalid/image" } }],
      },
    }).isError,
  ).toBe(true);
});
it.effect(
  "registers source-bound bot tools without blocking server startup and rejects another session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            registerBotExecutionContext(threadId, {
              prompt: "Bot context",
              restrictedTools: true,
              tools: [{ name: "allowed", inputSchema: {} }],
              call: async (name) => {
                calls.push(name);
                return { ok: true };
              },
            }),
          ),
          (remove) => Effect.sync(remove),
        );
        const server = yield* McpServer.McpServer;
        expect(server.tools.map(({ tool }) => tool.name)).toEqual(
          expect.arrayContaining(["bot_tools", "bot_call"]),
        );
        const invoke = (name: string, arguments_: Record<string, unknown>, scope = invocation) =>
          server
            .callTool({ name, arguments: arguments_ })
            .pipe(
              Effect.provideService(McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        expect((yield* invoke("bot_call", { name: "allowed", arguments: {} })).isError).not.toBe(
          true,
        );
        expect((yield* invoke("bot_call", { name: "blocked", arguments: {} })).isError).toBe(true);
        expect(
          (yield* invoke(
            "bot_call",
            { name: "allowed", arguments: {} },
            { ...invocation, threadId: ThreadId.make("neighbor") },
          )).isError,
        ).toBe(true);
        expect(calls).toEqual(["allowed"]);
        expect(
          (yield* Effect.exit(
            requireMcpCapability("agents").pipe(
              Effect.provideService(McpInvocationContext, invocation),
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            requireMcpCapability("agents").pipe(
              Effect.provideService(McpInvocationContext, {
                ...invocation,
                threadId: ThreadId.make("neighbor"),
              }),
            ),
          ))._tag,
        ).toBe("Success");
      }),
    ).pipe(Effect.provide(testLayer)),
);
