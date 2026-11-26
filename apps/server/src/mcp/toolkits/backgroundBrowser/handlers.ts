import * as Effect from "effect/Effect";
import type * as Tool from "effect/ai/Tool";
import * as Schema from "effect/Schema";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { BackgroundBrowser } from "./runtime.ts";
import { BackgroundBrowserToolkit } from "./tools.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import * as Option from "effect/Option";
import { isLiveCallerShell } from "../../threadAccess.ts";

const ownershipError = "The calling conversation or its browser ownership is unavailable.";

const ownedBrowser = Effect.fn("BackgroundBrowser.ownedBrowser")(function* () {
  const scope = yield* requireThreadMcpCapability("preview").pipe(
    Effect.mapError((error) => error.message),
  );
  if (scope.client !== undefined) return yield* Effect.fail(ownershipError);
  const { threadId, providerInstanceId, providerSessionId } = scope.thread;
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => "Could not load browser settings."),
  );
  const threads = yield* ThreadManagementService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(() => ownershipError));
  if (!shell || shell.id !== threadId || shell.deletedAt !== null ||
      !isLiveCallerShell(shell, providerInstanceId)) return yield* Effect.fail(ownershipError);
  const project = yield* (yield* ProjectStoreV2).getShell(shell.projectId).pipe(
    Effect.mapError(() => ownershipError),
  );
  if (Option.isNone(project) || project.value.id !== shell.projectId || project.value.archivedAt != null)
    return yield* Effect.fail(ownershipError);
  const bot = shell.bot;
  if (bot !== undefined) {
    const profile = Object.hasOwn(settings.bots, bot.id) ? settings.bots[bot.id] : undefined;
    if (!profile || profile.id !== bot.id || profile.archived ||
        (profile.projectId !== null && profile.projectId !== shell.projectId))
      return yield* Effect.fail(ownershipError);
    return { sessionId: `bot-thread:${threadId}`, threadId, executable: settings.lightpandaExecutablePath };
  }
  // Private pages must not register a viewer-visible thread alias in the pool.
  return { sessionId: providerSessionId, threadId: undefined, executable: settings.lightpandaExecutablePath };
});

const decodeArguments = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const request = Effect.fn("BackgroundBrowser.request")(function* (method: string, params: unknown) {
  const owner = yield* ownedBrowser();
  return yield* (yield* BackgroundBrowser).request(
    owner.sessionId, owner.executable, method, params, owner.threadId,
  );
});

export const BackgroundBrowserHandlers = BackgroundBrowserToolkit.toLayer(Effect.succeed(BackgroundBrowserToolkit.of({
  background_browser_tools: () =>
    request("tools/list", {}).pipe(Effect.map((tools) => ({ tools }))),
  background_browser_call: Effect.fn("background_browser_call")(function* (
    { name, argumentsJson }: Tool.Parameters<typeof BackgroundBrowserToolkit.tools.background_browser_call>,
  ) {
    const args = yield* decodeArguments(argumentsJson).pipe(
      Effect.mapError(() => "argumentsJson must contain a JSON object."),
    );
    return { result: yield* request("tools/call", { name, arguments: args }) };
  }),
  background_browser_close: Effect.fn("background_browser_close")(function* () {
    const owner = yield* ownedBrowser();
    return { closed: yield* (yield* BackgroundBrowser).close(owner.sessionId) };
  }),
})));
