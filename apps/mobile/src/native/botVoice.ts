import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type BotVoice = { readonly id: string; readonly name: string; readonly language: string };
export type BotVoiceEvent = {
  readonly sessionId: string;
  readonly type: "end" | "cancelled" | "error";
};
type BotVoiceModule = {
  voices(): Promise<ReadonlyArray<BotVoice>>;
  speak(text: string, voiceId: string | null, sessionId: string): Promise<void>;
  stop(): void;
  addListener(name: "onBotVoice", listener: (event: BotVoiceEvent) => void): { remove(): void };
};
const module =
  Platform.OS === "android" || Platform.OS === "ios"
    ? requireOptionalNativeModule<BotVoiceModule>("T3BotVoice")
    : null;
/** Older native clients remain usable but cannot offer bot voice until updated. */
export const botVoice = typeof module?.speak === "function" ? module : null;
