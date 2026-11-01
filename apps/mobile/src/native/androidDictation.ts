import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type AndroidDictationEvent = {
  sessionId: number;
  type: "ready" | "partial" | "final" | "level" | "error" | "end";
  text?: string;
  level?: number;
  message?: string;
};
type DictationModule = {
  startDictation(sessionId: number): Promise<void>;
  stopDictation(sessionId: number): void;
  cancelDictation(sessionId: number): void;
  addListener(
    name: "onDictation",
    listener: (event: AndroidDictationEvent) => void,
  ): { remove(): void };
};
const nativeDictation =
  Platform.OS === "android"
    ? requireOptionalNativeModule<DictationModule>("T3NativeControls")
    : null;
// An old installed dialog-only client needs a native rebuild for live dictation.
export const androidDictation =
  typeof nativeDictation?.startDictation === "function" ? nativeDictation : null;

let nextSession = 0;
export const nextAndroidDictationSession = () => ++nextSession;
