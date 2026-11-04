import { expect, it } from "vite-plus/test";
import { autoModelContext } from "./AutoModelContext.ts";

it("budgets path-based files as tool inputs, not images", () => {
  const result = autoModelContext({
    history: [],
    message: { text: "Summarize this", attachments: [{ type: "file" }] },
    hasSession: false,
    usedTokens: null,
  });
  expect(result.requiresImages).toBe(false);
  expect(result.requiredContextTokens).toBeGreaterThan(32768);
  expect(result.continuation).toBe(false);
});
it("uses a planning allowance for images in a new chat", () => {
  const result = autoModelContext({
    history: [],
    message: { text: "Explain", attachments: [{ type: "image" }] },
    hasSession: false,
    usedTokens: null,
  });
  expect(result).toMatchObject({ requiresImages: true, continuation: false, estimated: true });
  expect(result.requiredContextTokens).toBeGreaterThan(49152);
});
it("continues native sessions without inventing their hidden usage", () => {
  for (const usedTokens of [null, -1, Number.NaN]) {
    expect(
      autoModelContext({
        history: [],
        message: { text: "Continue", attachments: [] },
        hasSession: true,
        usedTokens,
      }),
    ).toMatchObject({ continuation: true, requiredContextTokens: null });
  }
});
it("recovers switching budgets from fresh usage without charging historical images twice", () => {
  expect(
    autoModelContext({
      history: [{ text: "old", attachments: [{ type: "image" }] }],
      message: { text: "Next", attachments: [] },
      hasSession: true,
      usedTokens: 1000,
    }),
  ).toMatchObject({ continuation: false, requiresImages: false, requiredContextTokens: 33772 });
});
