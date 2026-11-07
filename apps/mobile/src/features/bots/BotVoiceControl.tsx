import type { BotId, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AppText } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { uuidv4 } from "../../lib/uuid";
import { botVoice } from "../../native/botVoice";
import { environmentServerConfigsAtom } from "../../state/server";

export function BotVoiceControl({
  environmentId,
  botId,
  messageId,
  text,
}: {
  environmentId: EnvironmentId;
  botId: BotId;
  messageId: string | null;
  text: string;
}) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const profile = configs.get(environmentId)?.settings.bots[botId];
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef<string | null>(null);
  const lastMessage = useRef(messageId);
  const speak = useCallback(async () => {
    if (!botVoice || !text.trim()) return;
    const id = uuidv4();
    active.current = id;
    setSpeaking(true);
    setError(false);
    try {
      await botVoice.speak(text, profile?.voiceURI ?? null, id);
    } catch {
      if (active.current === id) {
        active.current = null;
        setSpeaking(false);
        setError(true);
      }
    }
  }, [text, profile?.voiceURI]);
  useEffect(() => {
    const subscription = botVoice?.addListener("onBotVoice", (event) => {
      if (active.current !== event.sessionId) return;
      active.current = null;
      setSpeaking(false);
      if (event.type === "error") setError(true);
    });
    return () => {
      subscription?.remove();
      if (active.current) {
        active.current = null;
        botVoice?.stop();
      }
    };
  }, []);
  useEffect(() => {
    if (lastMessage.current === messageId) return;
    lastMessage.current = messageId;
    if (messageId && profile?.voiceAutoPlay) void speak();
  }, [messageId, profile?.voiceAutoPlay, speak]);
  if (!botVoice || !text) return null;
  return (
    <View className="flex-row items-center gap-2 px-4">
      <MaterialButton
        tone="text"
        label={speaking ? "Stop voice" : "Read last reply"}
        onPress={() => {
          if (speaking) {
            active.current = null;
            botVoice?.stop();
            setSpeaking(false);
          } else void speak();
        }}
      />
      {error ? (
        <AppText accessibilityRole="alert">Voice playback failed on this device.</AppText>
      ) : null}
    </View>
  );
}
