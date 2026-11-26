import { BotId, EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@j1code/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { registerBotExecutionContext } from "../../../mausbot/ExecutionContext.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { BackgroundBrowser } from "./runtime.ts";
import { BackgroundBrowserToolkit } from "./tools.ts";
import { BackgroundBrowserHandlers } from "./handlers.ts";

const threadId = ThreadId.make("bot-thread");
const botId = BotId.make("bot");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
const projectId = ProjectId.make("project");
const at = "2026-08-01T00:00:00.000Z";
const project = {
  id: projectId, title: "Project", workspaceRoot: "/workspace",
  defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at,
};
const profile = {
  id: botId, name: "Bot", description: "", instructions: "", modelSelection,
  pinned: false, archived: false, projectId, createdAt: at, updatedAt: at,
};
const shell = { ...liveThreadShell(threadId), projectId };
function harness({
  caller = shell, bot = false, browserAllowed = true, oldProject = project,
  identity = profile, clientOnly = false, credential = "private-provider-session",
}: {
  caller?: typeof shell | null;
  bot?: boolean;
  browserAllowed?: boolean;
  oldProject?: (typeof project & { archivedAt?: string }) | null;
  identity?: typeof profile;
  clientOnly?: boolean;
  credential?: string;
} = {}) {
  const calls: unknown[][] = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller && bot ? { ...caller, bot: { id: botId, name: "Bot" } } : caller),
    }),
    Layer.mock(ProjectStoreV2)({ getShell: () => Effect.succeed(Option.fromNullishOr(oldProject)) }),
    ServerSettingsService.layerTest({
      lightpandaExecutablePath: "C:/browser/lightpanda.exe",
      bots: { [botId]: identity },
    }),
    Layer.succeed(BackgroundBrowser, {
      openThread: () => Effect.die("The handler must use the shared browser pool entry."),
      requestForThread: () => Effect.die("The viewer owns the page lookup."),
      request: (...args) => Effect.sync(() => {
        calls.push(args);
        return { content: [{ type: "text", text: "page evidence" }] };
      }),
      close: (id) => Effect.sync(() => {
        calls.push([id, "close"]);
        return true;
      }),
    }),
  );
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("remote-test"),
    thread: clientOnly ? undefined : { threadId, providerSessionId: credential, providerInstanceId },
    client: clientOnly ? { sessionId: "outside", label: "Outside", access: "full-access" } : undefined,
    requestNamespace: credential,
    capabilities: new Set(browserAllowed ? ["preview"] : []),
    issuedAt: 1,
  };
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provideService(McpInvocationContext, scope),
    Effect.provide(Layer.merge(
      BackgroundBrowserHandlers,
      dependencies,
    )),
  );
  const call = (argumentsJson = '{"url":"https://example.com"}') => run(Effect.gen(function* () {
    return yield* (yield* BackgroundBrowserToolkit)
      .handle("background_browser_call", { name: "goto", argumentsJson })
      .pipe(Stream.unwrap, Stream.runCollect);
  }));
  const close = () => run(Effect.gen(function* () {
    return yield* (yield* BackgroundBrowserToolkit)
      .handle("background_browser_close", {}).pipe(Stream.unwrap, Stream.runCollect);
  }));
  return { calls, call, close };
}

it.effect("keeps ordinary provider pages isolated and invisible to the bot viewer", () =>
  Effect.gen(function* () {
    const first = harness();
    const neighbor = harness({ credential: "other-provider-session" });
    yield* first.call();
    yield* neighbor.call();
    yield* first.close();
    expect(first.calls).toEqual([
      ["private-provider-session", "C:/browser/lightpanda.exe", "tools/call",
        { name: "goto", arguments: { url: "https://example.com" } }, undefined],
      ["private-provider-session", "close"],
    ]);
    expect(neighbor.calls[0]?.[0]).toBe("other-provider-session");
  }),
);

it.effect("uses the bot conversation's stable browser key for calls and close", () =>
  Effect.gen(function* () {
    const h = harness({ bot: true });
    yield* h.call();
    yield* h.close();
    expect(h.calls[0]?.[0]).toBe("bot-thread:bot-thread");
    expect(h.calls[0]?.[4]).toBe(threadId);
    expect(h.calls[1]).toEqual(["bot-thread:bot-thread", "close"]);
  }),
);

it.effect("rejects missing preview permission and outside clients before a process starts", () =>
  Effect.gen(function* () {
    for (const h of [harness({ browserAllowed: false }), harness({ clientOnly: true })]) {
      yield* h.call().pipe(Effect.flip);
      yield* h.close().pipe(Effect.flip);
      expect(h.calls).toEqual([]);
    }
  }),
);

it.effect("rejects stale, foreign, archived and deleted scope before call or close", () =>
  Effect.gen(function* () {
    for (const h of [
      harness({ caller: null }),
      harness({ caller: { ...shell, id: ThreadId.make("foreign") } }),
      harness({ caller: { ...shell, activeRunId: null } }),
      harness({ caller: { ...shell, providerInstanceId: ProviderInstanceId.make("other") } }),
      harness({ caller: { ...shell, archivedAt: shell.createdAt } }),
      harness({ caller: { ...shell, deletedAt: shell.createdAt } }),
      harness({ oldProject: null }),
      harness({ oldProject: { ...project, archivedAt: at } }),
      harness({ bot: true, identity: { ...profile, projectId: ProjectId.make("foreign") } }),
      harness({ bot: true, identity: { ...profile, archived: true } }),
    ]) {
      yield* h.call().pipe(Effect.flip);
      yield* h.close().pipe(Effect.flip);
      expect(h.calls).toEqual([]);
    }
  }),
);

it.effect("keeps the restricted bot capability guard ahead of ownership lookup", () =>
  Effect.gen(function* () {
    const dispose = registerBotExecutionContext(threadId, {
      restrictedTools: true, prompt: "", tools: [], call: async () => undefined,
    });
    try {
      const h = harness({ bot: true });
      yield* h.call().pipe(Effect.flip);
      expect(h.calls).toEqual([]);
    } finally {
      dispose();
    }
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
