import { useAtomValue } from "@effect/atom-react";
import { MessageId, type BotId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { createBotCallController } from "@t3tools/shared/bot-call-controller";
import { initialBotCallState } from "@t3tools/shared/bot-voice-conversation";
import { useEffect, useRef, useState } from "react";
import { newThreadId } from "../../lib/utils";
import { botCallTurn } from "../../state/botCallTurn";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom } from "../../state/server";
import { Button } from "../ui/button";
import {
  createWebCallMicrophone,
  type BrowserRecognition,
  type NativeDictation,
} from "./botCallMicrophone";

export function BotCallControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  botId: BotId;
  revision: string;
  blocked: boolean;
  startDisabled: boolean;
  onActiveChange: (active: boolean) => void;
  onSendVoice: (text: string) => Promise<MessageId | null>;
}) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const voiceId = configs.get(props.environmentId)?.settings.bots[props.botId]?.voiceURI ?? null;
  const latest = useRef({ ...props, voiceId });
  latest.current = { ...props, voiceId };
  const [state, setState] = useState(initialBotCallState);
  const controller = useRef<ReturnType<typeof createBotCallController> | null>(null);
  const query = useEnvironmentQuery(
    state.phase === "waiting" && state.messageId
      ? botCallTurn({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, messageId: MessageId.make(state.messageId) },
        })
      : null,
  );
  const browser =
    typeof window === "undefined"
      ? null
      : (window as typeof window & {
          SpeechRecognition?: new () => BrowserRecognition;
          webkitSpeechRecognition?: new () => BrowserRecognition;
        });
  const native = browser?.desktopBridge;
  const nativeAvailable =
    native?.getClientPlatform?.() === "win32" &&
    !!native.startDictation &&
    !!native.getDictationText &&
    !!native.stopDictation &&
    !!native.cancelDictation;
  const Constructor = browser?.SpeechRecognition ?? browser?.webkitSpeechRecognition;
  const available = !!browser?.speechSynthesis && (nativeAvailable || !!Constructor);
  useEffect(() => {
    if (!available || !browser) return;
    let call: ReturnType<typeof createBotCallController>;
    let playback: { utterance: SpeechSynthesisUtterance; resolve: () => void } | null = null;
    const mic = createWebCallMicrophone({
      ...(nativeAvailable
        ? { native: native as NativeDictation }
        : Constructor
          ? { createRecognition: () => new Constructor() }
          : {}),
      nextId: newThreadId,
      language: navigator.language,
      callbacks: {
        partial: (generation, text) => call.dispatch({ type: "partial", generation, text }),
        final: (generation, text) => call.dispatch({ type: "final", generation, text }),
        failed: (generation, error) => call.dispatch({ type: "failed", generation, error }),
      },
    });
    call = createBotCallController({
      listen: (generation) => mic.listen(generation),
      finishListening: (generation) => mic.finish(generation),
      cancelListening: (generation) => mic.cancel(generation),
      send: (text) =>
        latest.current.blocked ? Promise.resolve(null) : latest.current.onSendVoice(text),
      speak: (text) =>
        new Promise<void>((resolve, reject) => {
          const utterance = new SpeechSynthesisUtterance(text);
          const voice = browser.speechSynthesis
            .getVoices()
            .find((entry) => entry.voiceURI === latest.current.voiceId);
          if (voice) utterance.voice = voice;
          playback = { utterance, resolve };
          utterance.onend = () => {
            if (playback?.utterance === utterance) {
              playback = null;
              resolve();
            }
          };
          utterance.onerror = () => {
            if (playback?.utterance === utterance) {
              playback = null;
              reject(new Error("Voice playback failed."));
            }
          };
          browser.speechSynthesis.speak(utterance);
        }),
      stopSpeaking: () => {
        const current = playback;
        playback = null;
        browser.speechSynthesis.cancel();
        current?.resolve();
      },
      onState: setState,
    });
    controller.current = call;
    return () => {
      controller.current = null;
      call.dispose();
      mic.dispose();
    };
  }, [props.environmentId, props.threadId, props.botId, available]);
  useEffect(() => {
    props.onActiveChange(state.phase !== "idle" && state.phase !== "error");
  }, [props.onActiveChange, state.phase]);
  useEffect(() => () => props.onActiveChange(false), [props.onActiveChange]);
  useEffect(() => {
    if (props.blocked) controller.current?.dispatch({ type: "stop" });
  }, [props.blocked]);
  useEffect(() => {
    if (state.phase === "waiting") query.refresh();
  }, [props.revision, state.phase, query.refresh]);
  useEffect(() => {
    if (state.phase !== "waiting" || !state.messageId) return;
    if (query.error) {
      controller.current?.dispatch({
        type: "failed",
        generation: state.generation,
        error: "Could not check the bot's response.",
      });
      return;
    }
    const turn = query.data;
    if (!turn) return;
    if (turn.state === "error" || turn.state === "interrupted")
      controller.current?.dispatch({
        type: "failed",
        generation: state.generation,
        error: "The bot turn did not complete.",
      });
    else if (turn.state === "completed" && turn.text !== null)
      controller.current?.dispatch({
        type: "reply",
        generation: state.generation,
        messageId: state.messageId,
        text: turn.text,
      });
  }, [query.data, query.error, state]);
  if (!available) return null;
  const active = state.phase !== "idle" && state.phase !== "error";
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={props.blocked || (!active && props.startDisabled)}
        onClick={() => controller.current?.dispatch({ type: active ? "stop" : "start" })}
      >
        {active ? "End voice call" : "Start voice call"}
      </Button>
      {state.phase === "speaking" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => controller.current?.dispatch({ type: "interrupt" })}
        >
          Interrupt
        </Button>
      ) : null}
      {active ? (
        <span role="status">
          {state.phase === "listening" ? state.transcript || "Listening..." : state.phase}
        </span>
      ) : null}
      {state.error ? <span role="alert">{state.error}</span> : null}
    </div>
  );
}
