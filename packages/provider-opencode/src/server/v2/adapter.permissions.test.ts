import { describe, expect, it } from "vite-plus/test";
import { openCode2SessionRules } from "./adapter.ts";

const fullAccess = { runtimeMode: "full-access", interactionMode: "default" } as const;
const rules = (policy: Parameters<typeof openCode2SessionRules>[0]) =>
  openCode2SessionRules(policy, [], [], null).map(({ action, effect }) => [action, effect]);

describe("OpenCode 2 permission policy", () => {
  it("keeps ordinary Full Access prompt-free", () => {
    expect(rules(fullAccess)).toEqual([["*", "allow"]]);
    expect(rules({ ...fullAccess, approvalPolicy: "never" })).toEqual([["*", "allow"]]);
  });

  it("honors an explicit approval gate without a blanket allow", () => {
    expect(rules({ ...fullAccess, approvalPolicy: "on-request" })).toEqual([
      ["shell", "ask"], ["edit", "ask"], ["external_directory", "ask"],
    ]);
  });

  it("denies risky actions for a read-only override that cannot prompt", () => {
    expect(rules({ ...fullAccess, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } })).toEqual([
      ["shell", "deny"], ["edit", "deny"], ["external_directory", "deny"],
    ]);
  });
});
