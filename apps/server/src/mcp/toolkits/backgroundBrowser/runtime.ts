import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../../config.ts";
import { resolveBrowserExecutable } from "./executable.ts";
import { LightpandaPool } from "../../LightpandaProcess.ts";

export class BackgroundBrowser extends Context.Service<
  BackgroundBrowser,
  {
    readonly request: (
      sessionId: string,
      executable: string,
      method: string,
      params: unknown,
      threadId?: string,
    ) => Effect.Effect<unknown, string>;
    readonly requestForThread: (
      threadId: string,
      method: string,
      params: unknown,
    ) => Effect.Effect<unknown, string>;
    readonly close: (sessionId: string) => Effect.Effect<boolean>;
    readonly openThread: (threadId: string, executable: string) => Effect.Effect<void, string>;
  }
>()("t3/mcp/toolkits/backgroundBrowser/runtime/BackgroundBrowser") {}

export const BackgroundBrowserLive = Layer.effect(
  BackgroundBrowser,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const pool = new LightpandaPool();
    yield* Effect.addFinalizer(() => Effect.sync(() => pool.closeAll()));
    return BackgroundBrowser.of({
      openThread: (threadId, executable) =>
        Effect.tryPromise({
          try: () =>
            pool.openThread(
              threadId,
              resolveBrowserExecutable(executable, config.lightpandaExecutablePath),
            ),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }),
      close: (id) => Effect.sync(() => pool.close(id)),
      requestForThread: (threadId, method, params) =>
        Effect.tryPromise({
          try: (signal) => pool.requestForThread(threadId, method, params, signal),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }),
      request: (id, executable, method, params, threadId) =>
        Effect.tryPromise({
          try: (signal) =>
            pool.request(
              id,
              resolveBrowserExecutable(executable, config.lightpandaExecutablePath),
              method,
              params,
              signal,
              threadId,
            ),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }),
    });
  }),
);
