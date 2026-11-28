// @effect-diagnostics nodeBuiltinImport:off - Share the native runtime's on-disk workspace layout.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProviderTurnControlServiceV2 } from "../orchestration-v2/ProviderTurnControlService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MausbotExecutionHost } from "./ExecutionHost.ts";
import { createMausbotExecutionV2 } from "./ExecutionV2.ts";

class MausbotExecutionLifecycleError extends Schema.TaggedError<MausbotExecutionLifecycleError>()(
  "MausbotExecutionLifecycleError",
  { operation: Schema.Literals(["close", "refresh-catalog"]), cause: Schema.Defect() },
) {}

export const layer = Layer.effect(
  MausbotExecutionHost,
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projects = yield* ProjectStoreV2;
    const instances = yield* ProviderInstanceRegistry;
    const control = yield* ProviderTurnControlServiceV2;
    const settings = yield* ServerSettingsService;
    const { attachmentsDir, baseDir } = yield* ServerConfig;
    const mausbotDataDir = NodePath.join(baseDir, "userdata", "mausbot");
    const events = yield* EventSinkV2;
    let cursor = yield* events.latestSequence();
    const catalogChanges = yield* instances.subscribeChanges;

    const host = createMausbotExecutionV2(
      { orchestrator, projects, instances, control, settings, attachmentsDir, mausbotDataDir },
      Effect.runPromise,
      "stream",
    );
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () => host.close(),
        catch: (cause) => new MausbotExecutionLifecycleError({ operation: "close", cause }),
      }).pipe(
        Effect.catch(() => Effect.logWarning("Failed to stop one or more owned V2 bot turns.")),
      ),
    );

    // The initial cursor is captured before callers can dispatch. EventSink
    // subscribes before replaying from it, so a late reader can catch up.
    yield* Effect.suspend(() =>
      events.stream({ afterSequence: cursor }).pipe(
        Stream.runForEach(({ sequence, event }) =>
          Effect.sync(() => {
            if (sequence <= cursor) return;
            host.acceptEvent(event);
            cursor = sequence;
          }),
        ),
      ),
    ).pipe(
      Effect.tapError(() => Effect.logWarning("Retrying the V2 bot event reader.")),
      Effect.retry({ schedule: Schedule.spaced("1 second") }),
      Effect.forkScoped,
    );
    yield* Stream.fromSubscription(catalogChanges).pipe(
      Stream.runForEach(() =>
        Effect.tryPromise({
          try: (signal) => host.catalogChanged(signal),
          catch: (cause) =>
            new MausbotExecutionLifecycleError({ operation: "refresh-catalog", cause }),
        }).pipe(
          Effect.catch(() => Effect.logWarning("Could not refresh the V2 bot provider catalog.")),
        ),
      ),
      Effect.forkScoped,
    );

    return MausbotExecutionHost.of({ call: host.call, disconnect: host.disconnect });
  }),
);
