// @effect-diagnostics nodeBuiltinImport:off - temporary SQLite close/reopen fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId, EnvironmentId, EventId, MessageId, ProjectId, ProviderInstanceId, ProviderSessionId,
  ProviderThreadId, ProviderTurnId, RunAttemptId, RunId, ThreadId,
} from "@j1code/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@j1code/shared/nodeSqliteClient";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import type { DispatchModes } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Option from "effect/Option";

import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { Migration0060 as migration } from "../persistence/J1MigrationBridge.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import { automaticRouteFeedback } from "./feedback.ts";
import { strictRouteDescriptorFingerprint, type RouteRequest } from "./routeState.ts";
import {
  makeV2StrictAdmission,
  reconcileClaimedV2StrictDelivery,
  type WithStrictRouteFence,
} from "./v2StrictAdmission.ts";
import type { PreparedStrictRouteDelivery } from "./v2StrictDelivery.ts";

const request = {
  requestId: "strict-route",
  source: { environmentId: "local", projectId: "project", threadId: "source" },
  destination: { environmentId: "local", projectId: "project", threadId: "target" },
  content: "Use the already active turn.",
  permissionCeiling: [],
  destinationPermissions: [],
  visited: [],
  maxHops: 2,
  ambiguous: false,
  mode: "auto",
  initiation: "manual",
  monitorSource: true,
} satisfies RouteRequest;
const deliveryAttempt = "attempt-1";
const routeMode = { runtimeMode: "approval-required", interactionMode: "default" } as const;
const source = {
  environmentId: EnvironmentId.make(request.source.environmentId),
  threadId: ThreadId.make(request.source.threadId),
};
const destination = {
  ...routeMode,
  environmentId: EnvironmentId.make(request.destination.environmentId),
  threadId: ThreadId.make(request.destination.threadId),
  projectId: ProjectId.make(request.destination.projectId),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runId: RunId.make("run"),
};
const target = {
  ...routeMode,
  projectId: destination.projectId,
  providerInstanceId: destination.providerInstanceId,
  runId: destination.runId,
  attemptId: RunAttemptId.make("run-attempt"),
  providerSessionId: ProviderSessionId.make("provider-session"),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  providerTurnId: ProviderTurnId.make("provider-turn"),
  nativeThreadId: "native-thread",
  nativeTurnId: "native-turn",
  policyFingerprint: "policy",
};
const identity = strictRouteDescriptorFingerprint([request.requestId, deliveryAttempt]);
const prepared: PreparedStrictRouteDelivery = {
  attempt: {
    requestId: request.requestId, attemptId: deliveryAttempt, source, destination,
    ceiling: routeMode, text: request.content, attachments: [],
  },
  command: {
    type: "message.steer-strict",
    commandId: CommandId.make(`command:route-steer:${identity}`),
    messageId: MessageId.make(`message:route-steer:${identity}`),
    threadId: destination.threadId, senderThreadId: source.threadId, target,
    createdBy: "agent", creationSource: "server", text: request.content, attachments: [],
  },
};
const effectId = `effect:strict-steer:${strictRouteDescriptorFingerprint(prepared.command)}`;

// SQL CAS is exercised without an in-process fence, as when two owners race.
const noSharedFence: WithStrictRouteFence = (_id, work) => work;
const missingNativeEvidence = Layer.mergeAll(
  Layer.mock(CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeed(Option.none()) }),
  Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) }),
  Layer.mock(EventSinkV2)({}),
);
const nativeDelivered = (() => {
  const now = DateTime.makeUnsafe("2026-11-19T05:00:00.000Z");
  const timestamp = DateTime.formatIso(now);
  return Layer.mergeAll(
    Layer.mock(CommandReceiptStoreV2)({
      getByCommandId: (commandId) => Effect.succeed(Option.some({
        commandId, threadId: destination.threadId, commandType: "message.steer-strict",
        acceptedAt: now, resultSequence: 1, status: "accepted", error: null,
      })),
    }),
    Layer.mock(EffectOutboxV2)({
      listByCommandId: (commandId) => Effect.succeed([{
        id: effectId, commandId, threadId: destination.threadId,
        request: {
          type: "provider-turn.steer",
          providerSessionId: target.providerSessionId, providerThreadId: target.providerThreadId,
          providerTurnId: target.providerTurnId, messageId: prepared.command.messageId,
        },
        status: "succeeded", attemptCount: 1, availableAt: timestamp, createdAt: timestamp,
        updatedAt: timestamp, completedAt: timestamp, leaseOwner: null, lastError: null,
      }]),
    }),
    Layer.mock(EventSinkV2)({
      readByCommandId: ({ commandId }) => Stream.make({
        commandId, sequence: 1,
        event: {
          id: EventId.make("strict-event"), threadId: destination.threadId, occurredAt: now,
          type: "message.updated",
          payload: {
            id: prepared.command.messageId, threadId: destination.threadId,
            runId: target.runId, nodeId: null, role: "user", text: prepared.command.text,
            createdBy: "agent", creationSource: "server", attachments: [], streaming: false,
            createdAt: now, updatedAt: now,
            strictSteer: { target, commandFingerprint: strictRouteDescriptorFingerprint(prepared.command) },
          },
        },
      }),
    }),
  );
})();
// eslint-disable-next-line j1code/no-manual-effect-runtime-in-tests
const open = (filename: string) => ManagedRuntime.make(NodeSqliteClient.layer({ filename }));

const begin = Effect.gen(function* () {
  const store = yield* makeDurableRoutingStore;
  const queued = yield* store.create(request);
  const sending = yield* store.transition(request.requestId, queued.revision, {
    type: "begin-send", attemptId: deliveryAttempt,
  });
  return { store, sending };
});

describe("durable strict admission", () => {
  it("wins one SQL revision before submission and rejects changed intent or a legacy resend", async () => {
    const db = open(":memory:");
    try {
      await db.runPromise(migration);
      const { store, sending } = await db.runPromise(begin);
      let submitted = 0;
      let validated = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => { release = resolve; });
      const gate = makeV2StrictAdmission({
        store, expected: sending, withRouteFence: noSharedFence,
        validate: () => Effect.promise(async () => {
          if (++validated === 2) release();
          await bothRead;
          return { ...routeMode, interactionMode: "plan" as const };
        }),
      });
      const submit = (ceiling: DispatchModes) =>
        Effect.gen(function* () {
          expect(ceiling.interactionMode).toBe("plan");
          expect((yield* store.get(request.requestId))?.state.strictSubmission?.delivery).toEqual(prepared);
          ++submitted;
          return { status: "admitted", effectId } as const;
        });
      const results = await Promise.allSettled([
        db.runPromise(gate(prepared, submit)),
        db.runPromise(gate(prepared, submit)),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(submitted).toBe(1);
      const row = await db.runPromise(store.get(request.requestId));
      expect(row?.state.status).toBe("admitted");
      expect(await db.runPromise(store.unconfirmedStrict())).toEqual([request.requestId]);
      expect(await db.runPromise(gate({ ...prepared, command: { ...prepared.command, text: "changed" } }, () =>
        Effect.die("must not resend")))).toEqual({ status: "rejected", reason: "changed-intent" });
      await expect(db.runPromise(store.transition(request.requestId, row!.revision, {
        type: "admission-rejected",
      }))).rejects.toBeDefined();
    } finally {
      await db.dispose();
    }
  });

  it.each([false, true])("recovers the saved descriptor without resending after dispatch=%s", async (dispatched) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-strict-admission-"));
    const file = NodePath.join(directory, "fixture.sqlite");
    let db = open(file);
    try {
      await db.runPromise(migration);
      const { store, sending } = await db.runPromise(begin);
      expect(sending.state.strictSubmission).toBeUndefined();
      const legacyId = "legacy-neighbor";
      await db.runPromise(store.create({ ...request, requestId: legacyId, destination: null }));
      const gate = makeV2StrictAdmission({
        store, expected: sending, withRouteFence: noSharedFence,
        validate: () => Effect.succeed(routeMode),
      });
      let submits = 0;
      await expect(db.runPromise(gate(prepared, () => Effect.sync(() => {
        if (dispatched) ++submits;
        throw new Error("fixture interrupted before route settlement");
      })))).rejects.toBeDefined();
      expect(submits).toBe(dispatched ? 1 : 0);

      await db.dispose();
      db = open(file);
      const restored = await db.runPromise(makeDurableRoutingStore);
      const legacy = await db.runPromise(restored.get(legacyId));
      expect(legacy?.state.status).toBe("blocked");
      expect(legacy?.state).not.toHaveProperty("strictSubmission");
      await db.runPromise(restored.recoverInterruptedSends());
      const row = await db.runPromise(restored.get(request.requestId));
      expect(row?.state.status).toBe("uncertain");
      expect(row?.state.strictSubmission?.delivery).toEqual(prepared);
      const recovered = await db.runPromise(reconcileClaimedV2StrictDelivery({
        requestId: request.requestId, store: restored, withRouteFence: noSharedFence,
      }).pipe(Effect.provide(dispatched ? nativeDelivered : missingNativeEvidence)));
      expect(recovered?.evidence).toEqual(dispatched
        ? { status: "delivered", effectId }
        : { status: "uncertain", reason: "absent" });
      expect(recovered?.row.state.status).toBe(dispatched ? "delivered" : "uncertain");
      expect(await db.runPromise(restored.queued())).toEqual([]);
      const again = makeV2StrictAdmission({
        store: restored, expected: row!, withRouteFence: noSharedFence,
        validate: () => Effect.die("must not revalidate a consumed claim"),
      });
      expect(await db.runPromise(again(prepared, () => Effect.die("must not resend")))).toEqual(
        { status: "uncertain", reason: "ambiguous" },
      );
    } finally {
      await db.dispose();
      await NodeFSP.unlink(file).catch(() => {});
      await NodeFSP.rmdir(directory);
    }
  });

  it.each(["delivered", "failed", "cancelled"] as const)("settles only the exact native effect as %s", async (status) => {
    const db = open(":memory:");
    try {
      await db.runPromise(migration);
      const { store, sending } = await db.runPromise(begin);
      const denied = makeV2StrictAdmission({
        store, expected: sending, withRouteFence: noSharedFence, validate: () => Effect.succeed(null),
      });
      expect(await db.runPromise(denied(prepared, () => Effect.die("must not submit"))))
        .toEqual({ status: "rejected", reason: "admission" });
      const row = await db.runPromise(store.claimStrictSubmission(
        request.requestId, sending.revision, sending.state.fingerprint, prepared,
      ));
      const fingerprint = row.state.strictSubmission!.descriptorFingerprint;
      const admitted = await db.runPromise(store.settleStrictSubmission(
        request.requestId, row.revision, fingerprint, { status: "admitted", effectId },
      ));
      expect(admitted.state.status).toBe("admitted");
      expect(admitted.state.receipts).toEqual([]);
      await expect(db.runPromise(store.settleStrictSubmission(
        request.requestId, admitted.revision, fingerprint, { status, effectId: "wrong-outbox-row" },
      ))).rejects.toBeDefined();
      const settled = await db.runPromise(store.settleStrictSubmission(
        request.requestId, admitted.revision, fingerprint, { status, effectId },
      ));
      expect(settled.state.status).toBe(status === "delivered" ? "delivered" : "failed");
      expect(settled.state.strictSubmission?.delivery).toEqual(prepared);
      const statusReport = automaticRouteFeedback(settled.state);
      if (status === "delivered") expect(statusReport).toBeNull();
      else expect((await db.runPromise(store.get(statusReport!.requestId)))?.state.request.feedbackFor)
        .toBe(request.requestId);
    } finally {
      await db.dispose();
    }
  });
});
