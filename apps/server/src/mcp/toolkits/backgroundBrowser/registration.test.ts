import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  BackgroundBrowserToolkitRegistration,
  layerInProcessMcpServer,
} from "../../McpHttpServer.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import { BackgroundBrowser } from "./runtime.ts";

const registration = BackgroundBrowserToolkitRegistration.pipe(
  Layer.provideMerge(layerInProcessMcpServer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(ProjectStoreV2)({}),
      ServerSettings.layerTest(),
      liveThreadsLayer,
    ),
  ),
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
