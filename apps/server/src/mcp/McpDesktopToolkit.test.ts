import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import * as Desktop from "../desktop/DesktopAutomation.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import { DesktopToolkitRegistration } from "./McpHttpServer.ts";
import {
  McpInvocationContext,
  type McpInvocationScope,
  type McpCapability,
} from "./McpInvocationContext.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("desktop-mcp"),
  threadId: ThreadId.make("desktop-mcp-thread"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["desktop"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const png = Buffer.alloc(24);
png.writeUInt32BE(0x89504e47, 0);
png.writeUInt32BE(0x0d0a1a0a, 4);
png.write("IHDR", 12);
png.writeUInt32BE(800, 16);
png.writeUInt32BE(600, 20);

it.effect(
  "gates desktop tools, rejects non-desktop commands and returns screenshots as images",
  () => {
    let calls = 0;
    const runner = Layer.effect(
      ProcessRunner.ProcessRunner,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.gen(function* () {
              calls++;
              if (input.args[0] === "screenshot")
                yield* fs.writeFile(input.args.at(-1)!, png).pipe(Effect.orDie);
              return {
                stdout:
                  input.args[0] === "click"
                    ? encodeJson({
                        ok: false,
                        error: {
                          code: "STALE_REF",
                          disposition: { delivery: "not_delivered", retry: "safe" },
                        },
                      })
                    : encodeJson({ ok: true, data: { captured: true } }),
                stderr: "",
                code: ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        });
      }),
    );
    const testLayer = DesktopToolkitRegistration.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Desktop.layer.pipe(Layer.provide(runner))),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j1-desktop-mcp-" })),
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
        "desktop_act",
        "desktop_read",
        "desktop_screenshot",
      ]);
      const call = (name: string, args: Record<string, unknown>, allowed = true) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext, {
            ...invocation,
            capabilities: new Set<McpCapability>(allowed ? ["desktop"] : ["preview"]),
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const denied = yield* call("desktop_read", { command: "snapshot" }, false);
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Agent desktop access is disabled"),
          }),
        ]),
      );
      expect(calls).toBe(0);
      const invalid = yield* call("desktop_read", { command: "click", args: ["@s:e1"] }).pipe(
        Effect.flip,
      );
      expect(invalid._tag).toBe("InvalidParams");
      expect(calls).toBe(0);
      const read = yield* call("desktop_read", {
        command: "snapshot",
        args: ["--app", "Fixture", "-i", "--compact"],
      });
      expect(read.isError).toBe(false);
      const shot = yield* call("desktop_screenshot", { app: "Fixture" });
      expect(shot.isError).toBe(false);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.structuredContent).toMatchObject({ screenshot: { width: 800, height: 600 } });
      expect(encodeJson(shot.structuredContent)).not.toContain(png.toString("base64"));
      const stale = yield* call("desktop_act", { command: "click", args: ["@old:e1"] });
      expect(stale.isError).toBe(true);
      const text = stale.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain('"code":"STALE_REF"');
      expect(text?.type === "text" ? text.text : "").toContain('"actionMayHaveRun":false');
    }).pipe(Effect.scoped, Effect.provide(testLayer));
  },
);
