import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

const nativeDictation =
  Platform.OS === "android"
    ? requireOptionalNativeModule<{ dictate(): Promise<string>; cancelDictation(): void }>(
        "T3NativeControls",
      )
    : null;

// Older installed clients may expose this module without the new methods.
export const androidDictation =
  typeof nativeDictation?.dictate === "function" ? nativeDictation : null;
