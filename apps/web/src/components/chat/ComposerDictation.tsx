import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { newThreadId } from "../../lib/utils";
import { Button } from "../ui/button";

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
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
  const [level, setLevel] = useState(0);
  const [hasMeter, setHasMeter] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  }, [props]);
  const cancelRef = useRef<(() => void) | null>(null);
  const finishRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    onBusyChange(listening);
    return () => onBusyChange(false);
  }, [listening, onBusyChange]);
  useEffect(
    () => () => {
      latest.current = { ...latest.current, disabled: true };
      cancelRef.current?.();
    },
    [],
  );
  useEffect(() => {
    if (props.disabled) cancelRef.current?.();
  }, [props.disabled]);
  const start = async () => {
    if (cancelRef.current) return;
    let cancelled = false;
    let active = true;
    let transcript = "";
    let releaseMeter: (() => void) | undefined;
    let ownedSuffix = "";
    let edited = false;
    const insert = (text: string) => {
      if (!active || cancelled || latest.current.disabled || edited) return;
      const draft = latest.current.value;
      // Only replace words still owned by this session. An edit to the spoken
      // suffix takes ownership away from recognition, preserving the user's text.
      if (ownedSuffix && !draft.endsWith(ownedSuffix)) {
        edited = true;
        return;
      }
      const base = ownedSuffix ? draft.slice(0, -ownedSuffix.length) : draft;
      ownedSuffix = text.trim() ? (base && !/\s$/.test(base) ? " " : "") + text.trim() : "";
      const next = base + ownedSuffix;
      latest.current = { ...latest.current, value: next };
      if (next !== draft) latest.current.onChange(next);
    };
    const update = (text: string) => {
      if (!active || cancelled) return;
      transcript = text;
      insert(text);
    };
    const rollback = () => {
      insert("");
      cancelled = true;
    };
    const cleanup = () => {
      active = false;
      cancelRef.current = null;
      finishRef.current = null;
      setListening(false);
      setLevel(0);
      setHasMeter(false);
      releaseMeter?.();
    };
    setError(null);
    setListening(true);
    const bridge = window.desktopBridge;
    if (
      bridge?.getClientPlatform?.() === "win32" &&
      bridge.startDictation &&
      bridge.stopDictation &&
      bridge.getDictationText
    ) {
      const request = { requestId: newThreadId() };
      setHasMeter(!!bridge.getDictationLevel);
      const timer = setInterval(() => {
        void bridge
          .getDictationText?.(request)
          .then(update)
          .catch(() => {});
        void bridge
          .getDictationLevel?.(request)
          .then((value) => {
            if (active && !cancelled) setLevel(value);
          })
          .catch(() => {});
      }, 350);
      cancelRef.current = () => {
        rollback();
        void bridge.cancelDictation?.(request).catch(() => {});
      };
      finishRef.current = () => {
        void bridge.stopDictation?.(request).catch(() => {});
      };
      try {
        insert(await bridge.startDictation(request));
      } catch (cause) {
        if (!cancelled) {
          insert(transcript);
          setError(
            `${cause instanceof Error ? cause.message : String(cause)} Review any text already added.`,
          );
        }
      } finally {
        clearInterval(timer);
        cleanup();
      }
      return;
    }
    const browser = window as typeof window & {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Constructor) {
      cleanup();
      setError(
        "Dictation is unavailable in this browser. Use the Windows desktop app or your keyboard's dictation.",
      );
      return;
    }
    const recognition = new Constructor();
    recognition.lang = navigator.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    if (navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined") {
      void navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          if (!active) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          let context: AudioContext;
          try {
            context = new AudioContext();
          } catch {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          try {
            const analyser = context.createAnalyser();
            analyser.fftSize = 256;
            context.createMediaStreamSource(stream).connect(analyser);
            const samples = new Uint8Array(analyser.fftSize);
            setHasMeter(true);
            const timer = setInterval(() => {
              analyser.getByteTimeDomainData(samples);
              const rms = Math.sqrt(
                samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) /
                  samples.length,
              );
              setLevel(Math.min(100, rms * 300));
            }, 250);
            releaseMeter = () => {
              clearInterval(timer);
              stream.getTracks().forEach((track) => track.stop());
              void context.close();
            };
          } catch {
            stream.getTracks().forEach((track) => track.stop());
            void context.close();
          }
        })
        .catch(() => {});
    }
    let prior = "";
    let currentFinal = "";
    let finishing = false;
    let failed = false;
    const join = (...parts: string[]) => parts.filter(Boolean).join(" ").trim();
    recognition.onresult = (event) => {
      const results = Array.from(event.results);
      currentFinal = results
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      update(
        join(
          prior,
          results
            .map((result) => result[0]?.transcript ?? "")
            .join(" ")
            .trim(),
        ),
      );
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech") return;
      if (!cancelled) {
        failed = true;
        setError(`Dictation: ${event.error}`);
      }
    };
    recognition.onend = () => {
      prior = join(prior, currentFinal);
      currentFinal = "";
      if (!cancelled && !finishing && !failed) {
        try {
          recognition.start();
          return;
        } catch (cause) {
          setError(String(cause));
        }
      }
      insert(prior);
      cleanup();
    };
    cancelRef.current = () => {
      rollback();
      active = false;
      releaseMeter?.();
      releaseMeter = undefined;
      recognition.abort();
    };
    finishRef.current = () => {
      finishing = true;
      recognition.stop();
    };
    try {
      recognition.start();
    } catch (cause) {
      cleanup();
      setError(String(cause));
    }
  };
  return (
    <div className="flex items-center gap-2">
      {listening ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel dictation"
          onClick={() => cancelRef.current?.()}
        >
          <XIcon />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={props.disabled && !listening}
        aria-label={listening ? "Finish dictation" : "Dictate message"}
        title={listening ? "Finish dictation" : "Dictate message"}
        onClick={() => (listening ? finishRef.current?.() : void start())}
      >
        {listening ? <SquareIcon /> : <MicIcon />}
      </Button>
      {listening ? (
        <div className="flex items-center gap-2">
          {hasMeter ? (
            <span aria-label="Microphone level" className="flex h-4 items-center gap-px">
              {[
                ["a", 0.45],
                ["b", 0.7],
                ["c", 1],
                ["d", 0.7],
                ["e", 0.45],
              ].map(([key, scale]) => (
                <span
                  key={key}
                  className="w-0.5 rounded-full bg-current"
                  style={{ height: `${Math.max(2, level * Number(scale) * 0.16)}px` }}
                />
              ))}
            </span>
          ) : null}
          <span role="status" className="max-w-64 text-xs text-muted-foreground">
            Listening&#8230;
          </span>
        </div>
      ) : null}
      {error ? (
        <span role="alert" className="max-w-64 text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
