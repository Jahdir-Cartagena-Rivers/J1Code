import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { newThreadId } from "../../lib/utils";
import { Button } from "../ui/button";

type Recognition = {
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
};

export function ComposerDictation(props: {
  value: string;
  onChange: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}) {
  const { onBusyChange } = props;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    onBusyChange(listening);
    return () => onBusyChange(false);
  }, [listening, onBusyChange]);
  useEffect(() => () => cancelRef.current?.(), []);
  useEffect(() => {
    if (props.disabled) cancelRef.current?.();
  }, [props.disabled]);
  const start = async () => {
    if (cancelRef.current) {
      cancelRef.current();
      return;
    }
    const snapshot = props.value;
    let cancelled = false;
    const insert = (text: string) => {
      if (cancelled || latest.current.disabled) return;
      if (latest.current.value !== snapshot) {
        setError("The draft changed during dictation. Try again after editing.");
        return;
      }
      if (text.trim())
        latest.current.onChange(
          snapshot + (snapshot && !/\s$/.test(snapshot) ? " " : "") + text.trim(),
        );
    };
    setError(null);
    setListening(true);
    const bridge = window.desktopBridge;
    if (bridge?.getClientPlatform?.() === "win32" && bridge.startDictation) {
      const request = { requestId: newThreadId() };
      cancelRef.current = () => {
        cancelled = true;
        void bridge.cancelDictation?.(request).catch(() => {});
        setListening(false);
      };
      try {
        insert(await bridge.startDictation(request));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        cancelRef.current = null;
        setListening(false);
      }
      return;
    }
    const browser = window as typeof window & {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Constructor) {
      setListening(false);
      setError(
        "Dictation is unavailable in this browser. Use the Windows desktop app or your keyboard's dictation.",
      );
      return;
    }
    const recognition = new Constructor();
    recognition.lang = navigator.language;
    recognition.onresult = (event) =>
      insert(Array.from(event.results, (result) => result[0]?.transcript ?? "").join(" "));
    recognition.onerror = (event) => {
      if (!cancelled) setError(`Dictation: ${event.error}`);
    };
    recognition.onend = () => {
      cancelRef.current = null;
      setListening(false);
    };
    cancelRef.current = () => {
      cancelled = true;
      recognition.abort();
      setListening(false);
    };
    try {
      recognition.start();
    } catch (cause) {
      cancelRef.current = null;
      setListening(false);
      setError(String(cause));
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={props.disabled}
        aria-label={listening ? "Cancel dictation" : "Dictate message"}
        title={listening ? "Listening… click to cancel" : "Dictate message"}
        onClick={() => void start()}
      >
        {listening ? <SquareIcon /> : <MicIcon />}
      </Button>
      {error ? (
        <span role="alert" className="max-w-64 text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
