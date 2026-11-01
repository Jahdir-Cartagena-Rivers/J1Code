import type {
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import { resolveAutoModelPolicy } from "@t3tools/shared/projectSettings";
import { classifyAutoModelRequest } from "@t3tools/shared/autoModel";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { makeAutoModelAdmission } from "../../provider/AutoModelAdmission.ts";
import { autoModelCandidates, autoModelSelection } from "../../provider/AutoModelCandidates.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const autoAdmission = yield* makeAutoModelAdmission;
  const autoSettings = yield* Effect.serviceOption(ServerSettingsService);
  const autoProviders = yield* Effect.serviceOption(ProviderRegistry);
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          // A receipt only proves this exact command was handled. Replaying it
          // for a command aimed at another aggregate would report success for
          // work that never happened.
          if (
            existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
            existingReceipt.value.aggregateId !== aggregateRef.aggregateId
          ) {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            });
          }
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} changed before automatic settlement`,
          });
        }

        // The decider compares the lookup inputs. Only recreation needs an
        // event check, since it can reset a thread to the same field values.
        if (
          envelope.command.type === "thread.pull-request.sync" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
            type: "thread.created",
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} was recreated before pull request discovery`,
          });
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          threadBackgroundLiveness.getThreadBackgroundLiveness(envelope.command.threadId) !== null
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} has live background work`,
          });
        }

        // New and moved projects do not carry a resolved identity in the event-derived
        // command model. Legacy PR edits need it to identify the link they replace.
        if (
          envelope.command.type === "thread.meta.update" &&
          envelope.command.linkedPullRequest !== undefined
        ) {
          const threadId = envelope.command.threadId;
          const thread = commandReadModel.threads.find((thread) => thread.id === threadId);
          if (thread !== undefined) {
            const project = yield* projectionSnapshotQuery.getProjectShellById(thread.projectId);
            if (Option.isSome(project)) {
              commandReadModel = {
                ...commandReadModel,
                projects: commandReadModel.projects.map((entry) =>
                  entry.id === thread.projectId
                    ? { ...entry, repositoryIdentity: project.value.repositoryIdentity }
                    : entry,
                ),
              };
            }
          }
        }

        // Command snapshots omit activities at startup and cap them while running.
        // Read this request's durable state before deciding how to send the answer.
        const userInputActivity =
          envelope.command.type === "thread.user-input.respond" ||
          envelope.command.type === "thread.user-input.dismiss"
            ? yield* projectionSnapshotQuery.getUserInputActivity(envelope.command)
            : Option.none();
        let decisionReadModel = commandReadModel;
        if (envelope.command.type === "thread.history.import") {
          // The startup command model intentionally omits message bodies.
          // Hydrate only this history inside the command queue, after preceding
          // writes committed, so prefix validation also protects restarted apps.
          const historyThread = yield* projectionSnapshotQuery.getThreadDetailById(
            envelope.command.threadId,
          );
          if (Option.isSome(historyThread)) {
            decisionReadModel = {
              ...commandReadModel,
              threads: commandReadModel.threads.map((thread) =>
                thread.id === historyThread.value.id
                  ? { ...thread, messages: historyThread.value.messages }
                  : thread,
              ),
            };
          }
        }
        let routeAdmissionHydrated = false;
        if (envelope.command.type === "thread.route.deliver") {
          // Startup's command model omits message/activity details. Re-read the
          // destination while this queue owns admission, after prior writes.
          const targetShell = yield* projectionSnapshotQuery.getThreadShellById(
            envelope.command.threadId,
          );
          const targetDetail = yield* projectionSnapshotQuery.getThreadDetailById(
            envelope.command.threadId,
          );
          if (Option.isNone(targetShell) || Option.isNone(targetDetail)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail: "Route held: destination details are unavailable.",
            });
          }
          if (targetShell.value.hasPendingApprovals || targetShell.value.hasPendingUserInput) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail: "Route held: destination is awaiting approval or user input.",
            });
          }
          if (
            targetShell.value.modelSelection.instanceId !==
            envelope.command.originalProviderInstanceId
          ) {
            const instances = Option.isSome(autoProviders)
              ? yield* autoProviders.value.getProviders
              : [];
            const targetProvider = instances.find(
              (provider) => provider.instanceId === targetShell.value.modelSelection.instanceId,
            );
            if (
              !targetProvider ||
              !targetProvider.enabled ||
              !targetProvider.installed ||
              targetProvider.status !== "ready" ||
              targetProvider.availability === "unavailable" ||
              targetProvider.auth.status === "unauthenticated" ||
              !targetProvider.models.some(
                (model) => model.slug === targetShell.value.modelSelection.model,
              )
            ) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: envelope.command.type,
                detail: "Route held: destination provider or model is unavailable.",
              });
            }
          }
          decisionReadModel = {
            ...commandReadModel,
            threads: commandReadModel.threads.map((thread) =>
              thread.id === targetDetail.value.id
                ? {
                    ...thread,
                    messages: targetDetail.value.messages,
                    activities: targetDetail.value.activities,
                  }
                : thread,
            ),
          };
          routeAdmissionHydrated = true;
        }
        let admittedCommand = envelope.command;
        let autoSelection: { reason: string; resolverDurationMs: number | null } | undefined;
        if (admittedCommand.type === "thread.turn.start" && admittedCommand.autoRouting) {
          const command = admittedCommand;
          const classifiedTask = classifyAutoModelRequest(command.message.text);
          const reject = (detail: string) =>
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Auto: ${detail}`,
            });
          if (Option.isNone(autoSettings) || Option.isNone(autoProviders))
            return yield* reject("provider configuration unavailable");
          if (command.modelSelection)
            return yield* reject("choose explicit Auto intent or a manual model, not both");
          const detail = yield* projectionSnapshotQuery.getThreadDetailById(command.threadId);
          if (Option.isNone(detail)) return yield* reject("thread unavailable");
          const thread = detail.value;
          const shell = yield* projectionSnapshotQuery.getThreadShellById(command.threadId);
          if (
            Option.isNone(shell) ||
            shell.value.hasPendingApprovals ||
            shell.value.hasPendingUserInput
          )
            return yield* reject("thread is awaiting approval or input");
          if (thread.session?.activeTurnId) return yield* reject("a turn is still active");
          const settings = yield* autoSettings.value.getSettings.pipe(
            Effect.mapError(() => reject("settings unavailable")),
          );
          const policy = resolveAutoModelPolicy(settings, thread.projectId);
          if (policy?.mode !== "auto")
            return yield* reject("no enabled Auto policy for this project");
          const providers = yield* autoProviders.value.getProviders;
          const candidates = autoModelCandidates(policy, providers);
          // Native sessions carry hidden tool/context state. Never migrate those sessions implicitly.
          const compatible = candidates.filter(
            (candidate) =>
              !thread.session ||
              candidate.ref.instanceId ===
                (thread.session.providerInstanceId ?? thread.modelSelection.instanceId),
          );
          const textBytes = new TextEncoder().encode(
            thread.messages.map((message) => message.text).join("\n") + command.message.text,
          ).length;
          const hasAttachments =
            command.message.attachments.length > 0 ||
            thread.messages.some((message) => (message.attachments?.length ?? 0) > 0);
          const usage = thread.activities.findLast(
            (activity) => activity.kind === "context-window.updated",
          );
          const usedTokens =
            usage?.turnId === thread.latestTurn?.turnId &&
            Predicate.isObject(usage?.payload) &&
            Predicate.isNumber(usage.payload.usedTokens)
              ? usage.payload.usedTokens
              : null;
          const requiredContextTokens = hasAttachments
            ? null
            : thread.session
              ? usedTokens !== null
                ? usedTokens + new TextEncoder().encode(command.message.text).length + 32768
                : null
              : textBytes + 32768;
          const receipt = yield* autoAdmission
            .admit({
              threadId: command.threadId,
              requestId: command.commandId,
              input: {
                defaults: {
                  fast: candidates[0]!.ref,
                  deep: (
                    candidates.find(
                      (entry) =>
                        entry.ref.instanceId === policy.deep.instanceId &&
                        entry.ref.modelId === policy.deep.model,
                    ) ?? candidates[0]!
                  ).ref,
                },
                candidates: compatible,
                task: {
                  id: command.autoRouting!.taskId,
                  complexity: command.autoRouting!.complexity ?? classifiedTask.complexity,
                  highRisk: command.autoRouting!.highRisk ?? classifiedTask.highRisk,
                  crossComponent:
                    command.autoRouting!.crossComponent ?? classifiedTask.crossComponent,
                  requiresTools: true,
                  requiresImages: hasAttachments,
                  requiredContextTokens,
                },
                safeBoundary: true,
                requestEscalation:
                  command.autoRouting!.requestEscalation || classifiedTask.complexity === "complex",
              },
            })
            .pipe(
              Effect.mapError((error) =>
                reject(
                  "reason" in error
                    ? `${error.reason}${"exclusions" in error && error.exclusions?.length ? ` (${error.exclusions.join("; ")})` : ""}`
                    : "admission storage unavailable",
                ),
              ),
            );
          const selection = autoModelSelection(receipt.pin.ref, policy);
          const snapshot = providers.find((entry) => entry.instanceId === selection.instanceId);
          if (
            thread.session &&
            snapshot?.requiresNewThreadForModelChange &&
            selection.model !== thread.modelSelection.model
          )
            return yield* reject("provider requires a new thread for model changes");
          admittedCommand = { ...command, modelSelection: selection };
          autoSelection = {
            reason: receipt.reason,
            resolverDurationMs: receipt.resolverDurationMs,
          };
        }
        const eventBase = yield* decideOrchestrationCommand({
          command: admittedCommand,
          readModel: decisionReadModel,
          ...(autoSelection ? { autoSelection } : {}),
          ...(routeAdmissionHydrated ? { routeAdmissionHydrated: true } : {}),
          ...(Option.isSome(userInputActivity)
            ? { userInputActivity: userInputActivity.value }
            : {}),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandRejection(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const plannedEvents = Array.isArray(eventBase) ? eventBase : [eventBase];
        // Stamp the dispatching client's origin onto every event the command
        // produced. The decider stays pure; attribution is an engine concern.
        const eventBases =
          envelope.origin === undefined
            ? plannedEvents
            : plannedEvents.map((planned) => ({
                ...planned,
                metadata: { ...planned.metadata, origin: envelope.origin },
              }));
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              const attachmentCleanups: Effect.Effect<void>[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                const cleanup = yield* projectionPipeline.projectEventDeferred(savedEvent);
                attachmentCleanups.push(cleanup);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null && envelope.command.type === "thread.history.import") {
                // Another reader may have appended this exact suffix while
                // the import waited in the queue. Persist its successful receipt.
                yield* commandReceiptRepository.upsert({
                  commandId: envelope.command.commandId,
                  ...aggregateRef,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "accepted",
                  error: null,
                });
                return {
                  committedEvents,
                  attachmentCleanups,
                  lastSequence: commandReadModel.snapshotSequence,
                  nextCommandReadModel,
                } as const;
              }
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                attachmentCleanups,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const cleanup of committedCommand.attachmentCleanups) {
          yield* cleanup;
        }
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandIdConflictError(error)
          ) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandRejection(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.ignore);
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const readThreadEvents: OrchestrationEngineShape["readThreadEvents"] = ({ threadId, ...range }) =>
    eventStore.readAggregateRange({ ...range, aggregateKind: "thread", aggregateId: threadId });

  const getThreadReplayStats: OrchestrationEngineShape["getThreadReplayStats"] = ({
    threadId,
    ...range
  }) =>
    eventStore.getAggregateReplayStats({
      ...range,
      aggregateKind: "thread",
      aggregateId: threadId,
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        origin: options?.origin,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    readThreadEvents,
    getThreadReplayStats,
    dispatch,
    subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(Effect.map(Stream.fromSubscription)),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
