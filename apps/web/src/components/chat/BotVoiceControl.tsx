import { useAtomValue } from "@effect/atom-react";
import type { BotId, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { environmentServerConfigsAtom } from "../../state/server";
import { Button } from "../ui/button";

/** Speaks completed responses using the voice installed on this client device. */
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
  const bot = configs.get(environmentId)?.settings.bots[botId];
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef<SpeechSynthesisUtterance | null>(null);
  const lastMessage = useRef(messageId);
  const play = useCallback(() => {
    if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = window.speechSynthesis
      .getVoices()
      .find((entry) => entry.voiceURI === bot?.voiceURI);
    if (voice) utterance.voice = voice;
    active.current = utterance;
    utterance.addEventListener("end", () => {
      if (active.current === utterance) {
        active.current = null;
        setSpeaking(false);
      }
    });
    utterance.addEventListener("error", () => {
      if (active.current === utterance) {
        active.current = null;
        setSpeaking(false);
        setError(true);
      }
    });
    setError(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, [text, bot?.voiceURI]);
  useEffect(() => {
    if (lastMessage.current === messageId) return;
    lastMessage.current = messageId;
    if (messageId && bot?.voiceAutoPlay) play();
  }, [messageId, bot?.voiceAutoPlay, play]);
  useEffect(
    () => () => {
      if (active.current && typeof window !== "undefined" && "speechSynthesis" in window)
        window.speechSynthesis.cancel();
    },
    [],
  );
  if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  return (
    <div className="flex items-center gap-2">
      {error ? <span role="status">Voice playback failed on this device.</span> : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          if (speaking) {
            window.speechSynthesis.cancel();
            active.current = null;
            setSpeaking(false);
          } else play();
        }}
      >
        {speaking ? "Stop voice" : "Read last reply"}
      </Button>
    </div>
  );
}
