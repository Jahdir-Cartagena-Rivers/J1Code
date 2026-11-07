export interface CallRecognitionEvent {
  readonly sessionId: number;
  readonly type: "ready" | "partial" | "final" | "level" | "error" | "end";
  readonly text?: string;
  readonly message?: string;
}
export interface CallRecognition {
  startDictation(id: number): Promise<void>;
  stopDictation(id: number): void;
  cancelDictation(id: number): void;
  addListener(
    name: "onDictation",
    listener: (event: CallRecognitionEvent) => void,
  ): { remove(): void };
}
export interface CallMicrophoneCallbacks {
  partial(generation: number, text: string): void;
  final(generation: number, text: string): void;
  failed(generation: number, error: string): void;
}

/** Bridges native dictation into half-duplex turns without touching the composer draft. */
export function createBotCallMicrophone(options: {
  readonly recognition: CallRecognition;
  readonly requestPermission: () => Promise<boolean>;
  readonly nextSession: () => number;
  readonly androidSegments: boolean;
  readonly callbacks: CallMicrophoneCallbacks;
}) {
  let active: {
    generation: number;
    id: number;
    finishing: boolean;
    committed: string;
    final: string | null;
  } | null = null;
  let disposed = false;
  const join = (...parts: string[]) =>
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ");
  const subscription = options.recognition.addListener("onDictation", (event) => {
    const current = active;
    if (!current || event.sessionId !== current.id) return;
    if (event.type === "error") {
      active = null;
      options.recognition.cancelDictation(current.id);
      options.callbacks.failed(current.generation, event.message ?? "Speech recognition failed.");
      return;
    }
    if (event.type === "partial") {
      const text = options.androidSegments
        ? join(current.committed, event.text ?? "")
        : (event.text ?? "");
      options.callbacks.partial(current.generation, text);
    }
    if (event.type === "final") {
      const text = options.androidSegments
        ? join(current.committed, event.text ?? "")
        : (event.text ?? "");
      if (options.androidSegments && !current.finishing) current.committed = text;
      if (current.finishing) current.final = text;
      else options.callbacks.partial(current.generation, text);
    }
    if (event.type === "end") {
      active = null;
      const final =
        current.final ?? (options.androidSegments && current.committed ? current.committed : null);
      if (current.finishing && final !== null) options.callbacks.final(current.generation, final);
      else
        options.callbacks.failed(
          current.generation,
          "Speech recognition ended before the utterance was ready.",
        );
    }
  });
  return {
    async listen(generation: number) {
      if (disposed || active) throw new Error("Microphone is already in use.");
      const current = {
        generation,
        id: options.nextSession(),
        finishing: false,
        committed: "",
        final: null,
      };
      active = current;
      try {
        const allowed = await options.requestPermission();
        if (active !== current || disposed) return;
        if (!allowed) throw new Error("Microphone permission is required.");
        await options.recognition.startDictation(current.id);
        if (active !== current || disposed) options.recognition.cancelDictation(current.id);
      } catch (error) {
        if (active === current) active = null;
        throw error;
      }
    },
    finish(generation: number) {
      if (!active || active.generation !== generation || active.finishing) return;
      active.finishing = true;
      options.recognition.stopDictation(active.id);
    },
    cancel(generation: number) {
      if (!active || active.generation !== generation) return;
      const current = active;
      active = null;
      options.recognition.cancelDictation(current.id);
    },
    dispose() {
      disposed = true;
      if (active) {
        const current = active;
        active = null;
        options.recognition.cancelDictation(current.id);
      }
      subscription.remove();
    },
  };
}
