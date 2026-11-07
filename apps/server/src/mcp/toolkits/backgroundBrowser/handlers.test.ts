import { BotId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { BackgroundBrowser } from "./runtime.ts";
import { BackgroundBrowserToolkit } from "./tools.ts";
import { BackgroundBrowserHandlers } from "./handlers.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

function harness(allowed = true, bot = false) {
  const calls: unknown[][] = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadBotIdentity: () =>
        Effect.succeed(bot ? { id: BotId.make("test"), name: "Test", instructions: "" } : null),
    }),
    ServerSettingsService.layerTest({ lightpandaExecutablePath: "C:/browser/lightpanda.exe" }),
    Layer.succeed(BackgroundBrowser, {
      openThread: () => Effect.void,
      requestForThread: () => Effect.die("not used"),
      request: (...args) =>
        Effect.sync(() => {
          calls.push(args);
          return { content: [{ type: "text", text: "page evidence" }] };
        }),
      close: (id) =>
        Effect.sync(() => {
          calls.push([id, "close"]);
          return true;
        }),
    }),
  );
  const call = (argumentsJson = '{"url":"https://example.com"}') =>
    Effect.gen(function* () {
      const toolkit = yield* BackgroundBrowserToolkit;
      return yield* toolkit
        .handle("background_browser_call", { name: "goto", argumentsJson })
        .pipe(Stream.unwrap, Stream.runCollect);
    }).pipe(
      Effect.provide(BackgroundBrowserHandlers.pipe(Layer.provide(dependencies))),
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("remote-test"),
        threadId: ThreadId.make("bot-thread"),
        providerSessionId: "private-provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpCapability>(allowed ? ["preview"] : []),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { calls, call };
}

it.effect("uses the server executable and authenticated browser session", () =>
  Effect.gen(function* () {
    const h = harness();
    const result = yield* h.call();
    expect(h.calls).toEqual([
      [
        "private-provider-session",
        "C:/browser/lightpanda.exe",
        "tools/call",
        { name: "goto", arguments: { url: "https://example.com" } },
        "bot-thread",
      ],
    ]);
    expect(result).toBeDefined();
  }),
);
it.effect("uses the bot conversation's stable browser so user and provider share its page", () =>
  Effect.gen(function* () {
    const h = harness(true, true);
    yield* h.call();
    expect(h.calls[0]?.[0]).toBe("bot-thread:bot-thread");
  }),
);
it.effect("rejects credentials without agent browser access before launching a browser", () =>
  Effect.gen(function* () {
    const h = harness(false);
    const error = yield* h.call().pipe(Effect.flip);
    expect(String(error)).toContain("preview");
    expect(h.calls).toEqual([]);
  }),
);
it.effect.each(["null", "[]", "not-json"])(
  "rejects malformed arguments (%s) before invoking the process",
  (input) =>
    Effect.gen(function* () {
      const h = harness();
      const error = yield* h.call(input).pipe(Effect.flip);
      expect(String(error)).toContain("JSON object");
      expect(h.calls).toEqual([]);
    }),
);
