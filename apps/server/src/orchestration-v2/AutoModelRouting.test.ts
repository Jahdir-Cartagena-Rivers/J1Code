import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId, CommandId, NodeId, ProjectId, ProviderDriverKind,
  ProviderInstanceId, ProviderSessionId, ProviderThreadId, ProviderTurnId, ThreadId,
  type ChatAttachment, type OrchestrationV2ProviderThread, type OrchestrationV2ProviderTurn,
  type ServerProvider,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Sqlite from "../persistence/Sqlite.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { AutoModelRoutingV2, layer as autoLayer } from "./AutoModelRouting.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("auto-media");
const projectId = ProjectId.make("auto-media-project");
const nativeId = ProviderThreadId.make("auto-media-native");
const fast = { instanceId, model: "fast" };
const deep = { instanceId, model: "deep" };
const manual = { instanceId, model: "auto" };
const ready: ServerProvider = {
  instanceId, driver, enabled: true, installed: true, version: null, status: "ready",
  auth: { status: "authenticated" }, checkedAt: "2026-01-01T00:00:00Z",
  models: ["fast", "deep", "auto"].map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [], skills: [],
};

it.effect("budgets file and image attachments against the exact native thread's latest context", () =>
  Effect.gen(function* () {
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([ready]);
    const layer = autoLayer.pipe(Layer.provide(Layer.mergeAll(
      Sqlite.layerMemory,
      Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
      ServerSettings.layerTest({
        autoModelPolicy: {
          mode: "auto", fast, deep,
          capabilities: {
            fast: { tools: true, images: false, contextWindow: 80_000 },
            deep: { tools: true, images: true, contextWindow: 200_000 },
          },
        },
      }),
    )));
    yield* Effect.gen(function* () {
      const service = yield* AutoModelRoutingV2;
      const now = yield* DateTime.now;
      const native: OrchestrationV2ProviderThread = {
        id: nativeId, driver, providerInstanceId: instanceId,
        providerSessionId: ProviderSessionId.make("auto-media-session"), appThreadId: threadId,
        ownerNodeId: null, nativeThreadRef: { driver, strength: "strong", nativeId: "native" },
        nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: 1, lastRunOrdinal: 2,
        handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now,
        contextUsage: { usedTokens: 210_000 },
      };
      const turn = (ordinal: number, usedTokens?: number,
        providerThreadId = nativeId): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn:${providerThreadId}:${ordinal}`), providerThreadId,
        nodeId: NodeId.make(`node:${ordinal}`), runAttemptId: null, nativeTurnRef: null,
        ordinal, status: "completed", startedAt: now, completedAt: now,
        ...(usedTokens === undefined ? {} : { tokenUsage: { usedTokens, updatedAt: DateTime.formatIso(now) } }),
      });
      const request = (id: string, attachments: ChatAttachment[] = []) => ({
        threadId, commandId: CommandId.make(id), text: "Rewrite this", attachments,
        autoRouting: { taskId: id, requestEscalation: false },
      });
      const attachment = (type: "file" | "image"): ChatAttachment => ({
        type, id: ChatAttachmentId.make(`attachment_${type}`),
        name: type === "file" ? "notes.txt" : "photo.png",
        mimeType: type === "file" ? "text/plain" : "image/png", sizeBytes: 4_000_000,
      });
      const fresh = {
        thread: { projectId, modelSelection: manual, activeProviderThreadId: null },
        messages: [], providerThreads: [], providerTurns: [],
      };
      const candidate = (id: string, attachments: ChatAttachment[]) =>
        service.prepare(request(id, attachments), fresh, true, id);
      expect(yield* candidate("file", [attachment("file")])).toMatchObject({
        modelSelection: fast, proof: { reason: "simple", contextEstimated: true },
      });
      expect(yield* candidate("image", [attachment("image")])).toMatchObject({
        modelSelection: deep, proof: { reason: "capability-escalation", contextEstimated: true },
      });

      const saved = { ...fresh, thread: { ...fresh.thread, activeProviderThreadId: nativeId },
        providerThreads: [native] };
      const old = turn(1, 210_000);
      const other = turn(3, 15, ProviderThreadId.make("other-native"));
      expect(yield* service.prepare(request("manual-estimate"),
        { ...saved, providerTurns: [old, turn(2), other] }, true, "estimate")).toMatchObject({
        modelSelection: fast, proof: { contextEstimated: true },
      });
      expect(yield* service.prepare(request("manual-measured"),
        { ...saved, providerTurns: [old, turn(2, 100_000), other] }, true, "measured")).toMatchObject({
        modelSelection: deep,
      });
      const retained = { ...saved, thread: { ...saved.thread, modelSelection: fast } };
      const first = yield* service.prepare(request("retained"), retained, true, "retain");
      expect(first.proof.reason).toContain("Keeping the current model");
      yield* first.persist;
      const image = { ...request("retained-image", [attachment("image")]),
        autoRouting: { taskId: "retained", requestEscalation: false } };
      expect(yield* service.prepare(image, retained, true, "escalation")).toMatchObject({
        modelSelection: deep, proof: { reason: "escalated", contextEstimated: true },
      });
      expect((yield* Effect.result(service.prepare(image, retained, false, "active")))._tag).toBe("Failure");

      yield* Ref.set(providers, [{ ...ready, requiresNewThreadForModelChange: true }]);
      expect((yield* Effect.result(service.prepare(image, retained, true, "incompatible")))._tag).toBe("Failure");
      yield* Ref.set(providers, [ready]);
      expect((yield* Effect.result(service.prepare(request("too-large"),
        { ...saved, providerTurns: [turn(1, 210_000)] }, true, "large")))._tag).toBe("Failure");
    }).pipe(Effect.provide(layer));
  }),
);
