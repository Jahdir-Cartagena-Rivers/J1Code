// @effect-diagnostics nodeBuiltinImport:off - resolves the existing environment-owned store path.
import * as NodePath from "node:path";
import { HiveMindError, type HiveMindSearchResult } from "@j1code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ServerConfig } from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import { recallSelectedHive } from "./backend.ts";
import { HiveMindRuntime } from "./runtime.ts";
import { HiveLocalEngine } from "./localEngine.ts";
import { readHiveConfig } from "./config.ts";
import { HostProcessEnvironment, HostProcessPlatform } from "@j1code/shared/hostProcess";

export const hiveOperation = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => new HiveMindError({ message: String(error) }),
  });
export class HiveMindService extends Context.Service<
  HiveMindService,
  {
    readonly runtime: HiveMindRuntime;
    readonly search: (
      query: string,
      project?: string,
    ) => Effect.Effect<typeof HiveMindSearchResult.Type, HiveMindError>;
  }
>()("@j1code/server/hiveMind/HiveMindService") {
  static readonly layer = Layer.effect(
    HiveMindService,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const file = NodePath.join(config.stateDir, "hive-mind.json");
      const engine = new HiveLocalEngine(NodePath.join(config.logsDir, "hive-mind"), {
        platform: yield* HostProcessPlatform,
        environment: yield* HostProcessEnvironment,
      });
      const runtime = new HiveMindRuntime(file, async () =>
        engine.ensure(await readHiveConfig(file)),
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => runtime.close()));
      yield* forkParked(
        Effect.promise(() => runtime.automatic()).pipe(
          Effect.repeat(Schedule.spaced("30 seconds")),
        ),
      );
      return HiveMindService.of({
        runtime,
        search: (query, project) =>
          hiveOperation(async () => {
            return recallSelectedHive(runtime.file, query, project);
          }),
      });
    }),
  );
}
