import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { BackgroundBrowserToolkit } from "./tools.ts";
import { BackgroundBrowserHandlers } from "./handlers.ts";
import { BackgroundBrowserLive } from "./runtime.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const registration = McpServer.toolkit(BackgroundBrowserToolkit).pipe(
  Layer.provide(BackgroundBrowserHandlers),
  Layer.provide(
    Layer.mock(ProjectionSnapshotQuery)({ getThreadBotIdentity: () => Effect.succeed(null) }),
  ),
  Layer.provide(BackgroundBrowserLive),
  Layer.provide(
    ServerConfig.layerTest("/isolated-browser-test", {
      prefix: "background-browser-registration-",
    }),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(NodeServices.layer),
);

it.effect("registers native browser tools before any browser process starts", () =>
  Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    expect(registry.tools.map(({ tool }) => tool.name)).toContain("background_browser_call");
  }).pipe(Effect.provide(registration)),
);
