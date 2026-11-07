/** Pure call lifecycle. The host owns microphone, send and playback side effects. */
export type BotCallState = {
  readonly phase: "idle" | "listening" | "finishing" | "sending" | "waiting" | "speaking" | "error";
  readonly generation: number;
  readonly transcript: string;
  readonly messageId: string | null;
  readonly error: string | null;
};
export type BotCallAction =
  | { readonly type: "listen"; readonly generation: number }
  | { readonly type: "finishListening"; readonly generation: number }
  | { readonly type: "cancelListening"; readonly generation: number }
  | { readonly type: "send"; readonly generation: number; readonly text: string }
  | { readonly type: "speak"; readonly generation: number; readonly text: string }
  | { readonly type: "stopSpeaking"; readonly generation: number };
export type BotCallEvent =
  | { readonly type: "start" }
  | { readonly type: "stop" }
  | { readonly type: "interrupt" }
  | { readonly type: "partial"; readonly generation: number; readonly text: string }
  | { readonly type: "silence"; readonly generation: number }
  | { readonly type: "final"; readonly generation: number; readonly text: string }
  | { readonly type: "sent"; readonly generation: number; readonly messageId: string }
  | {
      readonly type: "reply";
      readonly generation: number;
      readonly messageId: string;
      readonly text: string;
    }
  | { readonly type: "spoken"; readonly generation: number }
  | { readonly type: "failed"; readonly generation: number; readonly error: string };
export const initialBotCallState: BotCallState = {
  phase: "idle",
  generation: 0,
  transcript: "",
  messageId: null,
  error: null,
};
type Transition = { readonly state: BotCallState; readonly actions: ReadonlyArray<BotCallAction> };

/** Generation numbers discard late recognition and playback callbacks after stop or interruption. */
export function advanceBotCall(state: BotCallState, event: BotCallEvent): Transition {
  const unchanged = (): Transition => ({ state, actions: [] });
  const listen = (): Transition => {
    const generation = state.generation + 1;
    return {
      state: { phase: "listening", generation, transcript: "", messageId: null, error: null },
      actions: [{ type: "listen", generation }],
    };
  };
  if (event.type === "start")
    return state.phase === "idle" || state.phase === "error" ? listen() : unchanged();
  if (event.type === "stop") {
    const actions: BotCallAction[] =
      state.phase === "listening" || state.phase === "finishing"
        ? [{ type: "cancelListening", generation: state.generation }]
        : state.phase === "speaking"
          ? [{ type: "stopSpeaking", generation: state.generation }]
          : [];
    return { state: { ...initialBotCallState, generation: state.generation + 1 }, actions };
  }
  if (event.type === "interrupt") {
    if (state.phase !== "speaking") return unchanged();
    const next = listen();
    return {
      state: next.state,
      actions: [{ type: "stopSpeaking", generation: state.generation }, ...next.actions],
    };
  }
  if (event.generation !== state.generation) return unchanged();
  if (event.type === "failed" && state.phase !== "idle") {
    const actions: BotCallAction[] =
      state.phase === "listening" || state.phase === "finishing"
        ? [{ type: "cancelListening", generation: state.generation }]
        : state.phase === "speaking"
          ? [{ type: "stopSpeaking", generation: state.generation }]
          : [];
    return { state: { ...state, phase: "error", error: event.error }, actions };
  }
  if (event.type === "partial" && state.phase === "listening")
    return { state: { ...state, transcript: event.text }, actions: [] };
  if (event.type === "silence" && state.phase === "listening" && state.transcript.trim())
    return {
      state: { ...state, phase: "finishing" },
      actions: [{ type: "finishListening", generation: state.generation }],
    };
  if (event.type === "final" && state.phase === "finishing") {
    const text = event.text.trim();
    return text
      ? {
          state: { ...state, phase: "sending", transcript: text },
          actions: [{ type: "send", generation: state.generation, text }],
        }
      : listen();
  }
  if (event.type === "sent" && state.phase === "sending")
    return { state: { ...state, phase: "waiting", messageId: event.messageId }, actions: [] };
  if (event.type === "reply" && state.phase === "waiting" && event.messageId === state.messageId) {
    const text = event.text.trim();
    return text
      ? {
          state: { ...state, phase: "speaking" },
          actions: [{ type: "speak", generation: state.generation, text }],
        }
      : listen();
  }
  if (event.type === "spoken" && state.phase === "speaking") return listen();
  return unchanged();
}
/** Only narrate the completed response belonging to the user message sent by this call. */
export function botCallCompletedReply(input: {
  readonly userMessageId: string;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly assistantMessageId: string | null;
    readonly userMessageId: string | null;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly turnId: string | null;
    readonly text: string;
    readonly streaming: boolean;
  }>;
}): { readonly messageId: string; readonly text: string } | null {
  const turn = input.latestTurn;
  if (!turn || turn.state !== "completed" || !turn.assistantMessageId) return null;
  if (turn.userMessageId !== input.userMessageId) return null;
  const assistant = input.messages.find(
    (message) =>
      message.id === turn.assistantMessageId &&
      message.role === "assistant" &&
      message.turnId === turn.turnId,
  );
  if (!assistant || assistant.streaming) return null;
  return { messageId: input.userMessageId, text: assistant.text };
}
