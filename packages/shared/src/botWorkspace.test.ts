import { BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { isStandaloneBotProject, standaloneBotWorkspace } from "./botWorkspace.ts";

describe("standalone bot workspaces", () => {
  it("uses stable, distinct paths for bots on Windows and Unix", () => {
    const a = standaloneBotWorkspace("C:\\J1\\bots", BotId.make("a"));
    const b = standaloneBotWorkspace("/var/j1/bots/", BotId.make("b"));
    expect(a).toEqual({ projectId: "j1-bot:a", workspaceRoot: "C:\\J1\\bots\\bot-a" });
    expect(b).toEqual({ projectId: "j1-bot:b", workspaceRoot: "/var/j1/bots/bot-b" });
    expect(isStandaloneBotProject(a.projectId)).toBe(true);
    expect(isStandaloneBotProject("j1-home")).toBe(false);
  });
  it("does not allow bot IDs to escape or share a workspace", () => {
    const slash = standaloneBotWorkspace("/bots", BotId.make("../other"));
    expect(slash.workspaceRoot).toBe("/bots/bot-%2E%2E%2Fother");
    expect(standaloneBotWorkspace("/bots", BotId.make("a/b")).projectId).not.toBe(
      standaloneBotWorkspace("/bots", BotId.make("a%2Fb")).projectId,
    );
    expect(
      standaloneBotWorkspace("C:\\bots", BotId.make("A")).workspaceRoot.toLowerCase(),
    ).not.toBe(standaloneBotWorkspace("C:\\bots", BotId.make("a")).workspaceRoot.toLowerCase());
    expect(standaloneBotWorkspace("C:\\bots", BotId.make("a.")).workspaceRoot).not.toBe(
      standaloneBotWorkspace("C:\\bots", BotId.make("a")).workspaceRoot,
    );
    const longId = BotId.make(String.fromCharCode(233).repeat(40));
    const workspace = standaloneBotWorkspace("/bots", longId);
    expect(workspace.workspaceRoot.length).toBeLessThan(100);
    expect(standaloneBotWorkspace("/bots", longId)).toEqual(workspace);
    expect(
      standaloneBotWorkspace("/bots", BotId.make(String.fromCharCode(233).repeat(39) + "e"))
        .projectId,
    ).not.toBe(workspace.projectId);
    expect(standaloneBotWorkspace("/bots", BotId.make("\ud800")).projectId).not.toBe(
      standaloneBotWorkspace("/bots", BotId.make("\ud801")).projectId,
    );
  });
});
