import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import { BackgroundBrowserToolkit } from "./tools.ts";
import { BackgroundBrowserHandlers } from "./handlers.ts";

const registration = Layer.effectDiscard(McpServer.registerToolkit(BackgroundBrowserToolkit)).pipe(
  Layer.provide(BackgroundBrowserHandlers),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers native browser tools before any browser process starts", () =>
  Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    expect(registry.tools.map(({ tool }) => tool.name).sort()).toEqual([
      "background_browser_call",
      "background_browser_close",
      "background_browser_tools",
    ]);
  }).pipe(Effect.provide(registration)),
);
