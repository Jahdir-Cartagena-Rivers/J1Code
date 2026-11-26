import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { MausbotApprovalModeInput } from "./rpc.ts";

const decode = Schema.decodeUnknownSync(MausbotApprovalModeInput);
describe("managed approval-mode boundary", () => {
  it("keeps the upstream thread-scoped confirmation fields", () => {
    expect(
      decode({
        botId: "bot-1",
        mode: "auto",
        options: { acknowledgeLocalAuto: true, threadId: "thread-1", threadOnly: true },
      }),
    ).toEqual({
      botId: "bot-1",
      mode: "auto",
      options: { acknowledgeLocalAuto: true, threadId: "thread-1", threadOnly: true },
    });
  });
  it.each([
    { botId: "bot-1", mode: "skip-approval" },
    { botId: "../other-bot", mode: "full" },
    { botId: "bot-1", mode: "auto", options: { acknowledgeLocalAuto: "true" } },
    { botId: "bot-1", mode: "custom", options: { threadId: "../other-thread" } },
  ])("rejects malformed authority-bearing input %#", (input) => {
    expect(() => decode(input)).toThrow();
  });
});


it("preserves an explicit Full Access thread choice without inventing acknowledgement", () => {
  const input = { botId: "bot-1", mode: "full", options: { threadId: "thread-1", threadOnly: true, updateBotDefault: false } };
  expect(decode(input)).toEqual(input);
  expect(decode(input).options).not.toHaveProperty("acknowledgeLocalAuto");
  expect(() => decode({ ...input, options: { ...input.options, refreshPermissions: "true" } })).toThrow();
});
