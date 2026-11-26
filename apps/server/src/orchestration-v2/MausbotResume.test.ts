import { expect, it } from "vite-plus/test";
import {
  RunId, type OrchestrationV2Command, type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@j1code/contracts";
import { stableStringify } from "@j1code/shared/relaySigning";
import { canAdmitMausbotResume, findMausbotIncidentFailure, matchesMausbotResumeReceipt, readMausbotResumeCursor } from "./MausbotResume.ts";

const source = RunId.make("run:source");
const modelSelection = { instanceId: "account", model: "saved-model" };
const thread = {
  id: "j1-mausbot:bot:task", bot: { id: "mausbot:bot" }, activeProviderThreadId: "p",
  providerInstanceId: "account", modelSelection, archivedAt: null, deletedAt: null,
};
const run = {
  id: source, threadId: thread.id, activeAttemptId: "attempt", rootNodeId: "node",
  userMessageId: "original-message", providerThreadId: "p", status: "interrupted", ordinal: 1,
  providerInstanceId: "account", modelSelection, startedAt: {},
};
const providerThread = {
  id: "p", appThreadId: thread.id, ownerNodeId: null, providerSessionId: "session",
  providerInstanceId: "account", status: "loaded", driver: "codex",
  nativeThreadRef: { driver: "codex", strength: "strong", nativeId: "previous-thread" },
};
const turn = {
  id: "turn", ordinal: 1, nodeId: "node", runAttemptId: "attempt", providerThreadId: "p",
  nativeTurnRef: { driver: "codex", strength: "strong", nativeId: "previous-turn" }, status: "interrupted", startedAt: {},
};
const attempt = {
  id: "attempt", runId: source, rootNodeId: run.rootNodeId, status: "interrupted", reason: "initial",
  attemptOrdinal: 1, providerThreadId: "p", providerInstanceId: "account", nativeThreadId: "previous-thread",
};
const session = { id: "session", driver: "codex", providerInstanceId: "account" };
const projection = {
  thread, runs: [run], attempts: [attempt], providerThreads: [providerThread], providerTurns: [turn],
  providerSessions: [session], runtimeRequests: [], turnItems: [],
};
const admit = (state: unknown = projection) =>
  canAdmitMausbotResume(state as OrchestrationV2ThreadProjection, source);

it("requires the exact saved bot, thread, account/tool signature and run cursor", () => {
  const cursor = "j1-shared:v2:bot:task:policy:run:source";
  expect(readMausbotResumeCursor(cursor, "bot", "task", "policy")).toBe(source);
  const encoded = "run:thread:j1-mausbot%3Abot%3Atask:ordinal:1";
  expect(readMausbotResumeCursor("j1-shared:v2:bot:task:policy:" + encoded, "bot", "task", "policy"))
    .toBe(encoded);
  expect(readMausbotResumeCursor("j1-shared:v2:bot:task:policy:run:bad%3", "bot", "task", "policy"))
    .toBeUndefined();
  expect(readMausbotResumeCursor("j1-shared:bot:task", "bot", "task", "policy")).toBeUndefined();
  expect(readMausbotResumeCursor(cursor, "bot", "task", "changed")).toBeUndefined();
  expect(readMausbotResumeCursor(cursor, "bot", "neighbor", "policy")).toBeUndefined();
  expect(readMausbotResumeCursor(cursor, "neighbor", "task", "policy")).toBeUndefined();
});

it("allows admitted interruption and refuses pending, busy, finished, or uncertain native input", () => {
  expect(admit()?.target).toMatchObject({
    sourceRunId: source, providerThreadId: "p", providerSessionId: "session",
    providerTurnId: "turn", nativeThreadId: "previous-thread", nativeTurnId: "previous-turn",
  });
  expect(admit({ ...projection, attempts: [{ ...attempt, nativeThreadId: undefined }] })?.target.nativeThreadId)
    .toBe("previous-thread");
  for (const state of [
    { ...projection, attempts: [] },
    { ...projection, attempts: [{ ...attempt, runId: "different-run" }] },
    { ...projection, providerThreads: [{ ...providerThread, nativeThreadRef: {
      ...providerThread.nativeThreadRef, nativeId: "replacement-thread",
    } }] },
    { ...projection, providerThreads: [{ ...providerThread, nativeThreadRef: {
      ...providerThread.nativeThreadRef, driver: "claudeAgent",
    } }] },
    { ...projection, providerTurns: [{ ...turn, nativeTurnRef: { ...turn.nativeTurnRef, driver: "claudeAgent" } }] },
    { ...projection, providerSessions: [{ ...session, driver: "claudeAgent" }] },
    { ...projection, runtimeRequests: [{ status: "pending" }] },
    { ...projection, runs: [run, { ...run, id: "later", ordinal: 2, status: "queued" }] },
    { ...projection, runs: [{ ...run, status: "completed" }] },
    { ...projection, runs: [{ ...run, status: "cancelled" }] },
    { ...projection, providerTurns: [{ ...turn, status: "running" }] },
    { ...projection, providerTurns: [{ ...turn, nativeTurnRef: null }] },
    { ...projection, providerSessions: [{ id: "session", providerInstanceId: "different" }] },
    { ...projection, thread: { ...thread, activeProviderThreadId: "different" } },
  ]) expect(admit(state)).toBeUndefined();
});

it("reuses a receipt only for the exact original native identity and message", () => {
  const target = admit()!.target;
  type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
  const command = { threadId: thread.id, messageId: run.userMessageId, text: "" } as Dispatch;
  const events = [{ event: { type: "run.created", payload: {
    threadId: thread.id, mausbotPromptless: target, manualContinuationOfRunId: source,
    providerThreadId: target.providerThreadId, userMessageId: run.userMessageId,
  } } }] as unknown as ReadonlyArray<OrchestrationV2StoredEvent>;
  expect(matchesMausbotResumeReceipt(command, target, events)).toBe(true);
  expect(matchesMausbotResumeReceipt(command, { ...target, incidentFailure: "failed-run-proof" }, events)).toBe(false);
  const incidentNote = { id: "note-id", chiefId: "chief", chiefThreadId: "chief-thread", text: "Check the result first." };
  const noteTarget = { ...target, incidentFailure: "failed-run-proof", incidentNote };
  const noteCommand = { ...command, text: incidentNote.text };
  const noteReceipt = [{ event: { type: "run.created", payload: {
    threadId: thread.id, mausbotPromptless: noteTarget, manualContinuationOfRunId: source,
    providerThreadId: target.providerThreadId, userMessageId: run.userMessageId,
  } } }] as unknown as ReadonlyArray<OrchestrationV2StoredEvent>;
  expect(matchesMausbotResumeReceipt(noteCommand, noteTarget, noteReceipt)).toBe(true);
  expect(matchesMausbotResumeReceipt(command, noteTarget, noteReceipt)).toBe(false);
  expect(matchesMausbotResumeReceipt(noteCommand, target, noteReceipt)).toBe(false);
  for (const changed of [
    { ...incidentNote, id: "replaced" },
    { ...incidentNote, chiefId: "foreign-chief" },
    { ...incidentNote, chiefThreadId: "foreign-thread" },
    { ...incidentNote, text: "Changed note." },
  ]) expect(matchesMausbotResumeReceipt(noteCommand, { ...noteTarget, incidentNote: changed }, noteReceipt)).toBe(false);
  const stored = events[0]!.event;
  if (stored.type !== "run.created") throw new Error("Expected run creation");
  expect(matchesMausbotResumeReceipt(command, target, [{ ...events[0]!, event: {
    ...stored, payload: { ...stored.payload,
      mausbotPromptless: Object.fromEntries(Object.entries(target).reverse()) as typeof target,
    },
  } }])).toBe(true);
  expect(matchesMausbotResumeReceipt(command, target, [{ ...events[0]!, event: {
    ...stored, payload: { ...stored.payload, threadId: "foreign-thread" as Dispatch["threadId"] },
  } }])).toBe(false);
  expect(matchesMausbotResumeReceipt(command, { ...target, nativeTurnId: "foreign" }, events)).toBe(false);
  expect(matchesMausbotResumeReceipt({ ...command, messageId: "different" as Dispatch["messageId"] },
    target, events)).toBe(false);
});

it("admits only the exact originally owned failed attempt for an affected-bot retry", () => {
  const failedRun = { ...run, status: "failed", mausbotOriginProviderSessionId: "session",
    mausbotOriginStart: { rootSource: { nativeMessageId: "native-request" },
      dispatch: "first", sourceMessageId: run.userMessageId },
  };
  const failedTurn = { ...turn, status: "failed" };
  const failedAttempt = { ...attempt, status: "failed" };
  const state = { ...projection, runs: [failedRun], providerTurns: [failedTurn], attempts: [failedAttempt] };
  const asProjection = (value: unknown) => value as OrchestrationV2ThreadProjection;
  const failure = findMausbotIncidentFailure(asProjection(state), source);
  expect(failure?.attemptId).toBe("attempt");
  const proof = stableStringify({ ...failure, policy: "a".repeat(64) });
  expect(canAdmitMausbotResume(asProjection(state), source, proof)?.run.id).toBe(source);
  expect(admit(state)).toBeUndefined();
  expect(canAdmitMausbotResume(asProjection(state), source, "uncertain")).toBeUndefined();
  expect(canAdmitMausbotResume(asProjection(state), source,
    stableStringify({ ...failure, attemptId: "other", policy: "a".repeat(64) }))).toBeUndefined();
  for (const changed of [
    { ...state, runs: [{ ...failedRun, mausbotOriginProviderSessionId: "other-session" }] },
    { ...state, runs: [{ ...failedRun, mausbotOriginStart: undefined }] },
    { ...state, attempts: [{ ...failedAttempt, nativeThreadId: "other-thread" }] },
    { ...state, providerTurns: [{ ...failedTurn, nativeTurnRef: null }] },
    { ...state, providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" }] },
    { ...state, runs: [failedRun, { ...failedRun, id: "later", ordinal: 2, status: "running" }] },
    { ...state, runtimeRequests: [{ status: "pending" }] },
  ]) expect(canAdmitMausbotResume(asProjection(changed), source, proof)).toBeUndefined();
});
