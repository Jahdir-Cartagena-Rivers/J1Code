import { resolveProjectProviderInstanceEnabled } from "@j1code/contracts";
import type {
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
} from "@j1code/contracts";
import { classifyAutoModelRequest } from "@j1code/shared/autoModel";
import { modelSelectionsEqual } from "@j1code/shared/model";
import { resolveAutoModelPolicy } from "@j1code/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutoModelAdmissionError, makeAutoModelAdmission } from "../provider/AutoModelAdmission.ts";
import { autoModelCandidates, autoModelSelection } from "../provider/AutoModelCandidates.ts";
import { autoModelContext } from "../provider/AutoModelContext.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { strictSteerFingerprint } from "./ProviderTurnControlService.ts";

type Message = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
type AutoMessage = Pick<Message, "threadId" | "commandId" | "text" | "attachments"> & {
  readonly autoRouting: NonNullable<Message["autoRouting"]>;
};
type AutoProjection = Pick<OrchestrationV2ThreadProjection, "messages" | "providerThreads" | "providerTurns"> & {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"],
    "projectId" | "modelSelection" | "activeProviderThreadId">;
};

/** The intake fingerprints the request before uploaded attachments receive server IDs. */
export const AuthoredRequestFingerprint = Context.Reference<string | undefined>(
  "j1/AuthoredRequestFingerprint",
  { defaultValue: () => undefined },
);

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const registry = yield* ProviderRegistry;
  const admission = yield* makeAutoModelAdmission;
  return {
    prepare: Effect.fn("AutoModelRoutingV2.prepare")(function* (
      command: AutoMessage,
      projection: AutoProjection,
      safeBoundary: boolean,
      requestFingerprint: string,
    ) {
      const { thread } = projection;
      const currentSettings = yield* settings.getSettings;
      const policy = resolveAutoModelPolicy(currentSettings, thread.projectId);
      if (policy?.mode !== "auto")
        return yield* new AutoModelAdmissionError({ reason: "No enabled Auto policy for this project." });
      const providers = (yield* registry.getProviders).filter(({ instanceId }) =>
        resolveProjectProviderInstanceEnabled(currentSettings, thread.projectId, instanceId));
      const candidates = autoModelCandidates(policy, providers);
      const [fast] = candidates;
      if (!fast) return yield* new AutoModelAdmissionError({ reason: "No configured Auto candidates." });
      const deep = candidates.find(({ ref }) =>
        ref.instanceId === policy.deep.instanceId && ref.modelId === policy.deep.model) ?? fast;
      const native = projection.providerThreads.find((entry) => entry.id === thread.activeProviderThreadId);
      const hasNativeContext = native !== undefined &&
        (native.providerSessionId !== null || native.nativeThreadRef !== null);
      const compatible = candidates.filter(({ ref }) => !(hasNativeContext || (!safeBoundary && native)) ||
        (ref.instanceId === native?.providerInstanceId &&
          (!providers.find(({ instanceId }) => instanceId === ref.instanceId)?.requiresNewThreadForModelChange ||
            modelSelectionsEqual(autoModelSelection(ref, policy), thread.modelSelection))));
      // A thread-level budget can predate the latest native turn or describe a handoff.
      // Use the newest turn for this exact native thread, even if it supplied no usage.
      let latestTurn: AutoProjection["providerTurns"][number] | undefined;
      if (safeBoundary && hasNativeContext) {
        for (const turn of projection.providerTurns) {
          if (turn.providerThreadId === native.id &&
              (latestTurn === undefined || turn.ordinal > latestTurn.ordinal)) latestTurn = turn;
        }
      }
      const context = autoModelContext({
        history: projection.messages,
        message: command,
        hasSession: hasNativeContext,
        usedTokens: latestTurn?.status === "completed" ? latestTurn.tokenUsage?.usedTokens ?? null : null,
      });
      const classified = classifyAutoModelRequest(command.text);
      const intent = command.autoRouting;
      const escalate = intent.requestEscalation || classified.complexity === "complex" ||
        intent.complexity === "complex" || intent.highRisk === true || intent.crossComponent === true;
      const currentCandidate = context.continuation && !escalate
        ? compatible.find(({ ref }) => modelSelectionsEqual(
            autoModelSelection(ref, policy), thread.modelSelection))
        : undefined;
      // A new image may need another model on the same native thread. At a safe
      // boundary, let the resolver check that model against the estimated budget.
      const continuation = safeBoundary && context.requiresImages && currentCandidate?.images !== true
        ? undefined
        : currentCandidate?.ref;
      const request = {
        threadId: command.threadId,
        requestId: command.commandId,
        input: {
          defaults: { fast: fast.ref, deep: deep.ref },
          candidates: compatible,
          ...(continuation === undefined ? {} : { continuation }),
          task: {
            id: intent.taskId,
            complexity: intent.complexity ?? classified.complexity,
            highRisk: intent.highRisk ?? classified.highRisk,
            crossComponent: intent.crossComponent ?? classified.crossComponent,
            requiresTools: true,
            requiresImages: context.requiresImages,
            requiredContextTokens: continuation ? null : context.estimatedTokens,
          },
          safeBoundary,
          requestEscalation: escalate,
        },
      };
      const receipt = yield* admission.admit(request, { preview: true });
      return {
        modelSelection: autoModelSelection(receipt.pin.ref, policy),
        proof: {
          requestFingerprint,
          taskId: intent.taskId,
          reason: receipt.reason === "context-continuation"
            ? "Keeping the current model while the provider manages context."
            : receipt.reason,
          ...(context.estimated && receipt.reason !== "context-continuation"
            ? { contextEstimated: true as const } : {}),
          resolverDurationMs: receipt.resolverDurationMs,
        },
        // The EventSink executes this in the same transaction as the run and command receipt.
        persist: admission.admit(request, { resolverDurationMs: receipt.resolverDurationMs }).pipe(
          Effect.flatMap((committed) =>
          committed.revision === receipt.revision &&
            strictSteerFingerprint(committed.pin) === strictSteerFingerprint(receipt.pin)
            ? Effect.void
            : Effect.fail(new AutoModelAdmissionError({ reason: "Auto selection changed before commit." }))),
        ),
      };
    }),
  };
});

export class AutoModelRoutingV2 extends Context.Service<AutoModelRoutingV2, Effect.Success<typeof make>>()(
  "@j1code/server/orchestration-v2/AutoModelRouting/AutoModelRoutingV2",
) {}

export const layer = Layer.effect(AutoModelRoutingV2, make);
