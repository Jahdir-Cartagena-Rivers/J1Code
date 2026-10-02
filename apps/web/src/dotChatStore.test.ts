import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";
import { normalizeDotChatUrl, readDotChatTarget, useDotChatStore } from "./dotChatStore";

const url = "https://chatgpt.com/dots/test-dot";
const storage = createMemoryStorage();
beforeEach(() => {
  useDotChatStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useDotChatStore.setState({ byEnvironment: {} });
});

describe("Dot chat targets", () => {
  it("keeps the conversation identity while removing copied query and fragment data", () => {
    expect(normalizeDotChatUrl(`  ${url}/?utm_source=copy#latest  `)).toBe(url);
  });

  it("rejects lookalike origins, credentials, other ChatGPT pages, and non-HTTPS links", () => {
    for (const invalid of [
      "https://chatgpt.com.evil.test/dots/test-dot",
      "https://user:pass@chatgpt.com/dots/test-dot",
      "http://chatgpt.com/dots/test-dot",
      "https://chatgpt.com/c/test-dot",
      "https://chatgpt.com/dots",
      "https://chatgpt.com:8443/dots/test-dot",
      "javascript:alert(1)",
    ])
      expect(normalizeDotChatUrl(invalid)).toBeNull();
  });

  it("rehydrates separate environment targets and forgets only the chosen link", async () => {
    storage.setItem(
      "j1:dot-chat:v1",
      JSON.stringify({
        state: {
          byEnvironment: {
            local: { url, profileId: "default" },
            remote: { url: `${url}-remote`, profileId: "work" },
          },
        },
        version: 0,
      }),
    );
    await useDotChatStore.persist.rehydrate();
    expect(useDotChatStore.getState().byEnvironment.local).toEqual({ url, profileId: "default" });
    useDotChatStore.getState().setTarget("local", null);
    await useDotChatStore.persist.rehydrate();
    expect(useDotChatStore.getState().byEnvironment.local).toBeUndefined();
    expect(useDotChatStore.getState().byEnvironment.remote).toEqual({
      url: `${url}-remote`,
      profileId: "work",
    });
  });

  it("ignores malformed saved targets instead of opening an arbitrary URL", async () => {
    storage.setItem(
      "j1:dot-chat:v1",
      JSON.stringify({
        state: {
          byEnvironment: {
            good: { url, profileId: "default" },
            bad: { url: "https://example.com", profileId: "default" },
            missing: { url },
            empty: { url, profileId: "" },
          },
        },
        version: 0,
      }),
    );
    await useDotChatStore.persist.rehydrate();
    expect(Object.keys(useDotChatStore.getState().byEnvironment)).toEqual(["good"]);
    expect(readDotChatTarget(null)).toBeNull();
  });
});
