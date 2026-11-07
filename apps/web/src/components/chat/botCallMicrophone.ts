export interface NativeDictation {
  startDictation(request: { requestId: string }): Promise<string>;
  getDictationText(request: { requestId: string }): Promise<string>;
  stopDictation(request: { requestId: string }): Promise<unknown>;
  cancelDictation(request: { requestId: string }): Promise<unknown>;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0?: { readonly transcript: string };
}
export interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export interface CallMicCallbacks {
  partial(generation: number, text: string): void;
  final(generation: number, text: string): void;
  failed(generation: number, error: string): void;
}
/** Adapts either Windows desktop dictation or browser recognition to a half-duplex call. */
export function createWebCallMicrophone(options: {
  native?: NativeDictation;
  createRecognition?: () => BrowserRecognition;
  nextId: () => string;
  language: string;
  callbacks: CallMicCallbacks;
}) {
  type Active = {
    generation: number;
    id: string;
    finishing: boolean;
    timer?: ReturnType<typeof setInterval>;
    recognition?: BrowserRecognition;
    text: string;
    final: string;
    prior: string;
  };
  let active: Active | null = null;
  let disposed = false;
  const join = (...items: string[]) =>
    items
      .map((item) => item.trim())
      .filter(Boolean)
      .join(" ");
  const clear = (current: Active) => {
    if (current.timer !== undefined) clearInterval(current.timer);
  };
  const fail = (current: Active, error: unknown) => {
    if (active !== current) return;
    active = null;
    clear(current);
    if (options.native)
      void options.native.cancelDictation({ requestId: current.id }).catch(() => {});
    else current.recognition?.abort();
    options.callbacks.failed(
      current.generation,
      error instanceof Error ? error.message : String(error),
    );
  };
  return {
    async listen(generation: number) {
      if (disposed || active) throw new Error("Microphone is already in use.");
      const current: Active = {
        generation,
        id: options.nextId(),
        finishing: false,
        text: "",
        final: "",
        prior: "",
      };
      active = current;
      if (options.native) {
        const request = { requestId: current.id };
        current.timer = setInterval(() => {
          void options.native
            ?.getDictationText(request)
            .then((text) => {
              if (active === current && !current.finishing)
                options.callbacks.partial(generation, text);
            })
            .catch((error: unknown) => fail(current, error));
        }, 350);
        void options.native.startDictation(request).then(
          (text) => {
            if (active !== current) return;
            active = null;
            clear(current);
            if (current.finishing) options.callbacks.final(generation, text);
            else
              options.callbacks.failed(
                generation,
                "Dictation ended before the utterance was ready.",
              );
          },
          (error: unknown) => fail(current, error),
        );
        return;
      }
      if (!options.createRecognition) {
        active = null;
        throw new Error("Speech recognition is unavailable on this client.");
      }
      const recognition = options.createRecognition();
      current.recognition = recognition;
      recognition.lang = options.language;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        if (active !== current) return;
        const results = Array.from(event.results);
        current.final = results
          .filter((item) => item.isFinal)
          .map((item) => item[0]?.transcript ?? "")
          .join(" ")
          .trim();
        current.text = join(
          current.prior,
          results.map((item) => item[0]?.transcript ?? "").join(" "),
        );
        if (!current.finishing) options.callbacks.partial(generation, current.text);
      };
      recognition.onerror = (event) => {
        if (event.error !== "no-speech") fail(current, `Speech recognition: ${event.error}`);
      };
      recognition.onend = () => {
        if (active !== current) return;
        current.prior = join(current.prior, current.final);
        current.final = "";
        if (current.finishing) {
          active = null;
          options.callbacks.final(generation, current.prior);
        } else {
          try {
            recognition.start();
          } catch (error) {
            fail(current, error);
          }
        }
      };
      try {
        recognition.start();
      } catch (error) {
        active = null;
        throw error;
      }
    },
    finish(generation: number) {
      if (!active || active.generation !== generation || active.finishing) return;
      const current = active;
      current.finishing = true;
      if (options.native)
        void options.native
          .stopDictation({ requestId: current.id })
          .catch((error: unknown) => fail(current, error));
      else current.recognition?.stop();
    },
    cancel(generation: number) {
      if (!active || active.generation !== generation) return;
      const current = active;
      active = null;
      clear(current);
      if (options.native)
        void options.native.cancelDictation({ requestId: current.id }).catch(() => {});
      else current.recognition?.abort();
    },
    dispose() {
      disposed = true;
      if (!active) return;
      const current = active;
      active = null;
      clear(current);
      if (options.native)
        void options.native.cancelDictation({ requestId: current.id }).catch(() => {});
      else current.recognition?.abort();
    },
  };
}
