import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
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

export const layer = Layer.effect(
  MausbotExecutionHost,
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projects = yield* ProjectStoreV2;
    const instances = yield* ProviderInstanceRegistry;
    const control = yield* ProviderTurnControlServiceV2;
    const settings = yield* ServerSettingsService;
    const { attachmentsDir } = yield* ServerConfig;
    const events = yield* EventSinkV2;
    let cursor = yield* events.latestSequence();
    const catalogChanges = yield* instances.subscribeChanges;

    const host = createMausbotExecutionV2(
      { orchestrator, projects, instances, control, settings, attachmentsDir },
      Effect.runPromise,
      "stream",
    );
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => host.close()).pipe(
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
        Effect.tryPromise((signal) => host.catalogChanged(signal)).pipe(
          Effect.catch(() => Effect.logWarning("Could not refresh the V2 bot provider catalog.")),
        ),
      ),
      Effect.forkScoped,
    );

    return MausbotExecutionHost.of({ call: host.call, disconnect: host.disconnect });
  }),
);
