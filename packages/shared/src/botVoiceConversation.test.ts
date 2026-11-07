import { describe, expect, it } from "vite-plus/test";
import {
  advanceBotCall,
  botCallCompletedReply,
  initialBotCallState,
} from "./botVoiceConversation.ts";

describe("bot voice call lifecycle", () => {
  it("stops listening before sending, then speaks only the reply to that turn", () => {
    const start = advanceBotCall(initialBotCallState, { type: "start" });
    const partial = advanceBotCall(start.state, {
      type: "partial",
      generation: 1,
      text: "Hello bot",
    });
    const finish = advanceBotCall(partial.state, { type: "silence", generation: 1 });
    expect(finish.actions).toEqual([{ type: "finishListening", generation: 1 }]);
    const send = advanceBotCall(finish.state, { type: "final", generation: 1, text: "Hello bot" });
    expect(send.actions).toEqual([{ type: "send", generation: 1, text: "Hello bot" }]);
    const waiting = advanceBotCall(send.state, {
      type: "sent",
      generation: 1,
      messageId: "user-1",
    });
    expect(
      advanceBotCall(waiting.state, {
        type: "reply",
        generation: 1,
        messageId: "other",
        text: "old",
      }).actions,
    ).toEqual([]);
    const reply = advanceBotCall(waiting.state, {
      type: "reply",
      generation: 1,
      messageId: "user-1",
      text: "Hi",
    });
    expect(reply.actions).toEqual([{ type: "speak", generation: 1, text: "Hi" }]);
    const next = advanceBotCall(reply.state, { type: "spoken", generation: 1 });
    expect(next.actions).toEqual([{ type: "listen", generation: 2 }]);
  });
  it("ignores empty silence, duplicate events, and callbacks from stopped sessions", () => {
    const started = advanceBotCall(initialBotCallState, { type: "start" });
    expect(advanceBotCall(started.state, { type: "silence", generation: 1 }).actions).toEqual([]);
    const stopped = advanceBotCall(started.state, { type: "stop" });
    expect(stopped.actions).toEqual([{ type: "cancelListening", generation: 1 }]);
    expect(
      advanceBotCall(stopped.state, { type: "final", generation: 1, text: "stale" }).actions,
    ).toEqual([]);
    expect(advanceBotCall(stopped.state, { type: "spoken", generation: 1 }).state.phase).toBe(
      "idle",
    );
  });
  it("interrupts playback before opening the microphone and rejects the old completion", () => {
    const speaking = { ...initialBotCallState, phase: "speaking" as const, generation: 4 };
    const interrupted = advanceBotCall(speaking, { type: "interrupt" });
    expect(interrupted.actions).toEqual([
      { type: "stopSpeaking", generation: 4 },
      { type: "listen", generation: 5 },
    ]);
    expect(advanceBotCall(interrupted.state, { type: "spoken", generation: 4 }).state.phase).toBe(
      "listening",
    );
  });
  it("does not restart after a failed operation without an explicit start", () => {
    const started = advanceBotCall(initialBotCallState, { type: "start" });
    const failed = advanceBotCall(started.state, {
      type: "failed",
      generation: 1,
      error: "Microphone denied",
    });
    expect(failed.state.phase).toBe("error");
    expect(failed.actions).toEqual([{ type: "cancelListening", generation: 1 }]);
    expect(
      advanceBotCall(failed.state, { type: "final", generation: 1, text: "ignored" }).actions,
    ).toEqual([]);
    expect(advanceBotCall(failed.state, { type: "start" }).actions).toEqual([
      { type: "listen", generation: 2 },
    ]);
  });
});

it("selects a finished reply only when the sent message and assistant belong to the completed turn", () => {
  const user = { id: "user-1", role: "user", turnId: null, text: "Hello", streaming: false };
  const assistant = {
    id: "reply-1",
    role: "assistant",
    turnId: "turn-1",
    text: "Hi",
    streaming: false,
  };
  const turn = {
    turnId: "turn-1",
    state: "completed" as const,
    assistantMessageId: "reply-1",
    userMessageId: "user-1",
  };
  expect(
    botCallCompletedReply({
      userMessageId: "user-1",
      latestTurn: turn,
      messages: [user, assistant],
    }),
  ).toEqual({ messageId: "user-1", text: "Hi" });
  expect(
    botCallCompletedReply({
      userMessageId: "user-1",
      latestTurn: { ...turn, state: "running" },
      messages: [user, assistant],
    }),
  ).toBeNull();
  expect(
    botCallCompletedReply({
      userMessageId: "user-1",
      latestTurn: turn,
      messages: [user, { ...assistant, streaming: true }],
    }),
  ).toBeNull();
  expect(
    botCallCompletedReply({
      userMessageId: "user-1",
      latestTurn: { ...turn, userMessageId: "other" },
      messages: [user, assistant],
    }),
  ).toBeNull();
});
