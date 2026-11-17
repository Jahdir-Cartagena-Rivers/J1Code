import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each([
    "j1code://",
    "j1code:///",
    "j1code-dev://",
    "j1code-preview://",
    "t3code://",
    "t3code:///",
    "t3code-dev://",
    "t3code-preview://",
  ])("ignores scheme-only URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });

  it.each([
    "j1code://threads/env-1/thread-1",
    "j1code-dev://pair?pairingUrl=x",
    "j1code-preview://settings/usage",
    "t3code://threads/env-1/thread-1",
    "t3code://pair?pairingUrl=x",
    "t3code-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each([
    "j1code://expo-development-client/?url=x",
    "j1code-dev://expo-sharing/anything",
    "t3code://expo-development-client/?url=x",
    "t3code://expo-sharing/anything",
  ])("ignores lifecycle URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });
});
