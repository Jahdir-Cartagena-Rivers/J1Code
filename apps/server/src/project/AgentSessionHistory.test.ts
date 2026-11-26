import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@j1code/contracts";
import {
  agentHistorySourceMessageId,
  ownsSourceImportedNativeHistory,
  reconcileAgentHistory,
} from "./AgentSessionHistory.ts";
import type { AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

const threadId = ThreadId.make("import:claudeAgent:compact-session");
const source: Array<AgentSessionThreadMessage> = Array.from({ length: 350 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  text: `Message ${index}`,
  createdAt: "2026-09-30T12:00:00.000Z",
  sourceMessageId: `source-${index}`,
}));
const saved = (messages: ReadonlyArray<AgentSessionThreadMessage>) =>
  messages.map((message, index) => ({
    id: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
    role: message.role,
    text: message.text,
    createdAt: "2026-09-29T12:00:00.000Z",
  }));

describe("external history continuity", () => {
  it("requires the saved native session identity while preserving Pi transcript paths", () => {
    type Thread = Parameters<typeof ownsSourceImportedNativeHistory>[0];
    type Provider = NonNullable<Parameters<typeof ownsSourceImportedNativeHistory>[1]>;
    const thread: Thread = {
      id: ThreadId.make("import:account:session"),
      historyOrigin: "v1_import",
      activeProviderThreadId: ProviderThreadId.make("provider-thread"),
      providerInstanceId: ProviderInstanceId.make("account"),
    };
    const nativeThreadRef = {
      strength: "strong",
      driver: ProviderDriverKind.make("codex"),
      nativeId: "session",
    } satisfies NonNullable<Provider["nativeThreadRef"]>;
    const provider: Provider = {
      id: ProviderThreadId.make("provider-thread"),
      appThreadId: thread.id,
      providerInstanceId: ProviderInstanceId.make("account"),
      ownerNodeId: null,
      driver: ProviderDriverKind.make("codex"),
      nativeThreadRef,
    };
    expect(ownsSourceImportedNativeHistory(thread, provider)).toBe(true);
    expect(ownsSourceImportedNativeHistory(thread, {
      ...provider, nativeThreadRef: { ...nativeThreadRef, nativeId: "foreign-session" },
    })).toBe(false);
    expect(ownsSourceImportedNativeHistory(thread, {
      ...provider, nativeThreadRef: { ...nativeThreadRef, nativeId: "" },
    })).toBe(false);
    expect(ownsSourceImportedNativeHistory(thread, {
      ...provider, nativeThreadRef: { ...nativeThreadRef, nativeId: null },
    })).toBe(false);
    expect(ownsSourceImportedNativeHistory(thread, undefined)).toBe(false);
    expect(ownsSourceImportedNativeHistory(thread, {
      ...provider, providerInstanceId: ProviderInstanceId.make("foreign-account"),
    })).toBe(false);
    expect(ownsSourceImportedNativeHistory(thread, {
      ...provider, driver: ProviderDriverKind.make("pi"),
      nativeThreadRef: { strength: "strong", driver: ProviderDriverKind.make("pi"), nativeId: "/saved/session.jsonl" },
    })).toBe(true);
  });
  it("preserves an exact legacy prefix even when later messages repeat its tail", () => {
    const before = saved(source.slice(0, 6)).map((message) => ({
      ...message,
      createdAt: source[0]!.createdAt,
    }));
    const repeating = [
      ...source.slice(0, 6),
      ...source
        .slice(3, 6)
        .map((message, index) => ({ ...message, sourceMessageId: `new-repeat-${index}` })),
    ];
    expect(reconcileAgentHistory(threadId, before, repeating)).toHaveLength(9);
  });
  it("recovers a legacy rolling window after compaction reserialized timestamps", () => {
    const before = saved([source[0]!, ...source.slice(51, 250)]);
    const result = reconcileAgentHistory(threadId, before, source)!;
    expect(result).toHaveLength(300);
    expect(result.slice(0, 200).map((message) => message.createdAt)).toEqual(
      before.map((message) => message.createdAt),
    );
    expect(result.slice(200).map((message) => message.text)).toEqual(
      source.slice(250).map((message) => message.text),
    );
    const persisted = result.map(({ messageId, ...message }) => ({
      ...message,
      id: messageId,
      updatedAt: message.createdAt,
      turnId: null,
      streaming: false,
    }));
    expect(reconcileAgentHistory(threadId, persisted, source)).toEqual(result);
  });

  it("rejects rewritten text, truncated histories and ambiguous repeated tails", () => {
    const before = saved(source.slice(0, 6));
    expect(reconcileAgentHistory(threadId, before, source.slice(0, 5))).toBeNull();
    expect(
      reconcileAgentHistory(
        threadId,
        before,
        source.map((message, index) => (index === 0 ? { ...message, text: "Rewritten" } : message)),
      ),
    ).toBeNull();
    expect(reconcileAgentHistory(threadId, before, [...source, ...source.slice(3, 6)])).toBeNull();
  });

  it("preserves persisted SHA-256 message IDs for UTF-8 source identities", () => {
    const sourceMessageId = "source-\u2603";
    const id = agentHistorySourceMessageId(threadId, sourceMessageId);
    expect(id).toBe(
      `${threadId}:source:0d1532702ff7c6a16859721c5aab02268d84e9b7077d7f31c74a12bb8cebdf46`,
    );
    expect(reconcileAgentHistory(threadId, [], [{ ...source[0]!, sourceMessageId }])?.[0]?.messageId)
      .toBe(id);
  });

  it("uses stable identities to distinguish repeated prompts", () => {
    const repeating = source
      .slice(0, 4)
      .map((message) => ({ ...message, role: "user" as const, text: "Continue" }));
    const initial = reconcileAgentHistory(threadId, [], repeating.slice(0, 3))!;
    const before = initial.map(({ messageId, ...message }) => ({
      ...message,
      id: messageId,
      updatedAt: message.createdAt,
      turnId: null,
      streaming: false,
    }));
    expect(reconcileAgentHistory(threadId, before, repeating)?.at(-1)?.messageId).not.toBe(
      before.at(-1)?.id,
    );
    const changed = repeating.map((message, index) =>
      index === 2 ? { ...message, text: "Rewritten content" } : message,
    );
    expect(reconcileAgentHistory(threadId, before, changed)).toBeNull();
  });
});
