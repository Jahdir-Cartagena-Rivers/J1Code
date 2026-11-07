import {
  advanceBotCall,
  initialBotCallState,
  type BotCallAction,
  type BotCallEvent,
  type BotCallState,
} from "./botVoiceConversation.ts";

export interface BotCallPorts {
  listen(generation: number): Promise<void>;
  finishListening(generation: number): void;
  cancelListening(generation: number): void;
  send(text: string): Promise<string | null>;
  speak(text: string, generation: number): Promise<void>;
  stopSpeaking(generation: number): void;
  onState(state: BotCallState): void;
}
/** Orchestrates a call while all capture, sending and playback stay in client-owned adapters. */
export function createBotCallController(ports: BotCallPorts, silenceMs = 1200) {
  let state = initialBotCallState;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const fail = (generation: number, error: unknown) =>
    dispatch({
      type: "failed",
      generation,
      error: error instanceof Error ? error.message : String(error),
    });
  const run = (action: BotCallAction) => {
    switch (action.type) {
      case "listen":
        void ports.listen(action.generation).catch((error) => fail(action.generation, error));
        break;
      case "finishListening":
        ports.finishListening(action.generation);
        break;
      case "cancelListening":
        ports.cancelListening(action.generation);
        break;
      case "stopSpeaking":
        ports.stopSpeaking(action.generation);
        break;
      case "send":
        void ports.send(action.text).then(
          (messageId) => {
            if (messageId === null) fail(action.generation, "The message could not be sent.");
            else dispatch({ type: "sent", generation: action.generation, messageId });
          },
          (error) => fail(action.generation, error),
        );
        break;
      case "speak":
        void ports.speak(action.text, action.generation).then(
          () => dispatch({ type: "spoken", generation: action.generation }),
          (error) => fail(action.generation, error),
        );
        break;
    }
  };
  function dispatch(event: BotCallEvent) {
    if (disposed) return;
    const previous = state;
    const transition = advanceBotCall(previous, event);
    state = transition.state;
    if (state !== previous) ports.onState(state);
    if (state.phase !== "listening") clearTimer();
    if (
      event.type === "partial" &&
      state.phase === "listening" &&
      event.generation === state.generation &&
      state.transcript !== previous.transcript
    ) {
      clearTimer();
      if (state.transcript.trim())
        timer = setTimeout(
          () => dispatch({ type: "silence", generation: event.generation }),
          silenceMs,
        );
    }
    for (const action of transition.actions) {
      try {
        run(action);
      } catch (error) {
        if (action.type !== "cancelListening" && action.type !== "stopSpeaking")
          fail(action.generation, error);
      }
    }
  }
  return {
    getState: () => state,
    dispatch,
    dispose: () => {
      if (disposed) return;
      dispatch({ type: "stop" });
      disposed = true;
      clearTimer();
    },
  };
}
