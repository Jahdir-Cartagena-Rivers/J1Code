import { describe, expect, it } from "vite-plus/test";
import { nativeLoginInput } from "./native-login-input.ts";

describe("Lightpanda saved-login input", () => {
  it("uses the existing page for URL reads and upstream login scripts", async () => {
    const calls: unknown[] = [];
    const input = nativeLoginInput(async (name, args) => {
      calls.push({ name, args });
      return {
        content: [
          {
            type: "text",
            text:
              args.script === "JSON.stringify({url:location.href})"
                ? '{"url":"https://example.com/login"}'
                : '{"focused":true}',
          },
        ],
      };
    });
    expect(await input.engine(["get", "url"])).toEqual({ url: "https://example.com/login" });
    expect(await input.engine(["eval", "login-script"])).toEqual({ result: '{"focused":true}' });
    expect(await input.engine(["open", "https://other.example"])).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("sends input privately and discards responses that may echo a secret", async () => {
    const calls: unknown[] = [];
    const input = nativeLoginInput(async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "test-secret" }] };
    });
    expect(await input.insertText("test-secret")).toBeUndefined();
    expect(await input.press("Enter")).toBeUndefined();
    expect(await input.click("button")).toBeUndefined();
    expect(calls).toEqual([
      { name: "fill", args: { selector: ":focus", value: "test-secret" } },
      { name: "press", args: { selector: ":focus", key: "Enter" } },
      { name: "click", args: { selector: "button" } },
    ]);
  });

  it("hides browser errors and never navigates to recover a stopped page", async () => {
    for (const call of [
      async () => {
        throw new Error("test-secret");
      },
      async () => ({ isError: true, content: [{ type: "text", text: "test-secret" }] }),
    ]) {
      const input = nativeLoginInput(call);
      await expect(input.insertText("test-secret")).rejects.not.toThrow("test-secret");
    }
  });
});
