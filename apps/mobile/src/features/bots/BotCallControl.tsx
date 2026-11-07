import type { BotId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createBotCallController } from "@t3tools/shared/bot-call-controller";
import { initialBotCallState } from "@t3tools/shared/bot-voice-conversation";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { AppText } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { uuidv4 } from "../../lib/uuid";
import { androidDictation, nextAndroidDictationSession } from "../../native/androidDictation";
import { iosLiveDictation, nextIOSLiveDictationSession } from "../../native/iosLiveDictation";
import { botVoice } from "../../native/botVoice";
import { botCallTurn } from "../../state/botCallTurn";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom } from "../../state/server";
import { createBotCallMicrophone } from "./botCallMicrophone";

const recognition = iosLiveDictation ?? androidDictation;
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
          input: { threadId: props.threadId, messageId: state.messageId as MessageId },
        })
      : null,
  );
  useEffect(() => {
    if (!recognition || !botVoice) return;
    const voice = botVoice;
    let playback: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null;
    let call: ReturnType<typeof createBotCallController>;
    const mic = createBotCallMicrophone({
      recognition,
      requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
      nextSession: iosLiveDictation ? nextIOSLiveDictationSession : nextAndroidDictationSession,
      androidSegments: !!androidDictation,
      callbacks: {
        partial: (generation, text) => call.dispatch({ type: "partial", generation, text }),
        final: (generation, text) => call.dispatch({ type: "final", generation, text }),
        failed: (generation, error) => call.dispatch({ type: "failed", generation, error }),
      },
    });
    const subscription = voice.addListener("onBotVoice", (event) => {
      if (!playback || event.sessionId !== playback.id) return;
      const current = playback;
      playback = null;
      if (event.type === "error") current.reject(new Error("Voice playback failed."));
      else current.resolve();
    });
    call = createBotCallController({
      listen: (generation) => mic.listen(generation),
      finishListening: (generation) => mic.finish(generation),
      cancelListening: (generation) => mic.cancel(generation),
      send: (text) =>
        latest.current.blocked ? Promise.resolve(null) : latest.current.onSendVoice(text),
      speak: (text) =>
        new Promise<void>((resolve, reject) => {
          const id = uuidv4();
          playback = { id, resolve, reject };
          void voice.speak(text, latest.current.voiceId, id).catch((error: unknown) => {
            if (playback?.id === id) {
              playback = null;
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
        }),
      stopSpeaking: () => {
        voice.stop();
        const current = playback;
        playback = null;
        current?.resolve();
      },
      onState: setState,
    });
    controller.current = call;
    const appState = AppState.addEventListener("change", (next) => {
      if (next !== "active") call.dispatch({ type: "stop" });
    });
    return () => {
      controller.current = null;
      call.dispose();
      mic.dispose();
      subscription.remove();
      appState.remove();
    };
  }, [props.environmentId, props.threadId, props.botId]);
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
    if (turn.state === "error" || turn.state === "interrupted") {
      controller.current?.dispatch({
        type: "failed",
        generation: state.generation,
        error: "The bot turn did not complete.",
      });
    } else if (turn.state === "completed" && turn.text !== null) {
      controller.current?.dispatch({
        type: "reply",
        generation: state.generation,
        messageId: state.messageId,
        text: turn.text,
      });
    }
  }, [query.data, query.error, state]);
  if (!recognition || !botVoice) return null;
  const active = state.phase !== "idle" && state.phase !== "error";
  return (
    <View className="flex-row items-center gap-2 px-4">
      <MaterialButton
        tone="text"
        disabled={props.blocked || (!active && props.startDisabled)}
        label={active ? "End voice call" : "Start voice call"}
        onPress={() => controller.current?.dispatch({ type: active ? "stop" : "start" })}
      />
      {state.phase === "speaking" ? (
        <MaterialButton
          tone="text"
          label="Interrupt"
          onPress={() => controller.current?.dispatch({ type: "interrupt" })}
        />
      ) : null}
      {active ? (
        <AppText>
          {state.phase === "listening" ? state.transcript || "Listening..." : state.phase}
        </AppText>
      ) : null}
      {state.error ? <AppText accessibilityRole="alert">{state.error}</AppText> : null}
    </View>
  );
}
