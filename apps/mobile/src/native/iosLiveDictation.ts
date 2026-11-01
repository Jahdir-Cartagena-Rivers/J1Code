import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type IOSLiveDictationEvent = {
  sessionId: number;
  type: "ready" | "partial" | "final" | "level" | "error" | "end";
  /** Complete session transcript, replacing the previous value (never append). */
  text?: string;
  /** Microphone RMS mapped to 0..1, emitted at most approximately 10 times/second. */
  level?: number;
  message?: string;
  reason?: "finished" | "cancelled" | "interrupted" | "permissionDenied" | "unavailable" | "error";
};

type IOSLiveDictationModule = {
  startDictation(sessionId: number): Promise<void>;
  stopDictation(sessionId: number): void;
  cancelDictation(sessionId: number): void;
  addListener(
    name: "onDictation",
    listener: (event: IOSLiveDictationEvent) => void,
  ): { remove(): void };
};

const nativeModule =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<IOSLiveDictationModule>("T3LiveDictation")
    : null;

/** Null on old binaries; rebuild after registering T3LiveDictationModule. */
export const iosLiveDictation =
  typeof nativeModule?.startDictation === "function" ? nativeModule : null;

let nextSession = 0;
export const nextIOSLiveDictationSession = () => ++nextSession;
