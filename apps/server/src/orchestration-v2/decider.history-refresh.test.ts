import { expect, it } from "@effect/vitest";
import { MessageId, RunId, ThreadId } from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import { agentHistorySourceMessageId } from "../project/AgentSessionHistory.ts";
import { matchesImportedHistoryPrefix } from "../project/AgentSessionImporter.ts";

const threadId = ThreadId.make("import:codex:external");
const timestamp = "2026-08-24T09:00:00.000Z";
const history = [
  { role: "user", text: "First question", createdAt: timestamp },
  { role: "assistant", text: "First answer", createdAt: timestamp },
] as const;
const savedFields = {
  runId: null,
  creationSource: "server",
  createdAt: DateTime.makeUnsafe(timestamp),
  streaming: false,
} as const;
const first = { ...history[0], ...savedFields, id: MessageId.make(`${threadId}:000000`) };
const second = { ...history[1], ...savedFields, id: MessageId.make(`${threadId}:000001`) };
const continued = [...history, { role: "user", text: "External follow-up", createdAt: timestamp }] as const;

it("accepts a canonical saved prefix for an unchanged transcript and an append", () => {
  expect(matchesImportedHistoryPrefix(threadId, [first, second], history)).toBe(true);
  expect(matchesImportedHistoryPrefix(threadId, [first, second], continued)).toBe(true);
});

it("preserves a legacy source digest only for the matching native identity", () => {
  const sourceMessageId = "saved-native-id";
  const prior = { ...second, id: agentHistorySourceMessageId(threadId, sourceMessageId) };
  expect(matchesImportedHistoryPrefix(threadId, [first, prior], [
    history[0], { ...history[1], sourceMessageId }, continued[2],
  ])).toBe(true);
  expect(matchesImportedHistoryPrefix(threadId, [first, prior], [
    history[0], { ...history[1], sourceMessageId: "different-native-id" }, continued[2],
  ])).toBe(false);
});

it("rejects rewritten, truncated or ambiguously identified saved history", () => {
  expect(matchesImportedHistoryPrefix(threadId, [first, second], [history[0]])).toBe(false);
  expect(matchesImportedHistoryPrefix(threadId, [first, second], [
    { ...history[0], text: "Rewritten" }, ...continued.slice(1),
  ])).toBe(false);
  expect(matchesImportedHistoryPrefix(threadId, [first, { ...second, id: first.id }], continued)).toBe(false);
  expect(matchesImportedHistoryPrefix(threadId, [
    first, { ...second, id: MessageId.make("foreign-message") },
  ], continued)).toBe(false);
});

it("rejects a J1-authored follow-up even when its text matches the native transcript", () => {
  const followUp = {
    ...continued[2],
    id: MessageId.make(`${threadId}:000002`),
    runId: RunId.make("local-follow-up"),
    creationSource: "web" as const,
    createdAt: DateTime.makeUnsafe(timestamp),
    streaming: false,
  };
  expect(matchesImportedHistoryPrefix(threadId, [first, second, followUp], continued)).toBe(false);
});
