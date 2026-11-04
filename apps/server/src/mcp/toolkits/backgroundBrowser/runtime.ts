import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LightpandaPool } from "../../LightpandaProcess.ts";

export class BackgroundBrowser extends Context.Service<
  BackgroundBrowser,
  {
    readonly request: (
      sessionId: string,
      executable: string,
      method: string,
      params: unknown,
    ) => Effect.Effect<unknown, string>;
    readonly close: (sessionId: string) => Effect.Effect<boolean>;
  }
>()("t3/mcp/toolkits/backgroundBrowser/runtime/BackgroundBrowser") {}

export const BackgroundBrowserLive = Layer.effect(
  BackgroundBrowser,
  Effect.gen(function* () {
    const pool = new LightpandaPool();
    yield* Effect.addFinalizer(() => Effect.sync(() => pool.closeAll()));
    return BackgroundBrowser.of({
      close: (id) => Effect.sync(() => pool.close(id)),
      request: (id, executable, method, params) =>
        Effect.tryPromise({
          try: (signal) => pool.request(id, executable, method, params, signal),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }),
    });
  }),
);
