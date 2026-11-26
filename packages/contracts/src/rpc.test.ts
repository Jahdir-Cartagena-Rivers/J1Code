import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { DesktopShellEnvironmentSnapshot } from "./resourceTelemetry.ts";

describe("WebSocket RPC contracts", () => {
  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});



describe("J1 extensions on the current RPC group", () => {
  it("keeps supported J1 methods registered alongside V2 dispatch", () => {
    for (const method of [
      WS_METHODS.mausbotOpen, WS_METHODS.mausbotApprovalMode,
      WS_METHODS.botRoutineHistory, WS_METHODS.botCallTurn,
      WS_METHODS.botBrowserPage, WS_METHODS.botBrowserAction,
      WS_METHODS.hiveMindSnapshot, WS_METHODS.hiveMindSearch, WS_METHODS.hiveMindImport,
      "routing.list", "routing.prepare", "routing.confirm", "routing.status",
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    ]) expect(WsRpcGroup.requests.has(method)).toBe(true);
  });

  it("does not alias a legacy turn command into current V2 dispatch", () => {
    const rpc = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (rpc === undefined) throw new Error("Missing current dispatch");
    const decode = Schema.decodeUnknownExit(rpc.payloadSchema);
    expect(Exit.isFailure(decode({
      type: "thread.turn.start", commandId: "legacy-start", threadId: "thread-1",
      message: { messageId: "message-1", role: "user", text: "Legacy input", attachments: [] },
      runtimeMode: "full-access", interactionMode: "default", createdAt: "2026-11-18T00:00:00.000Z",
    }))).toBe(true);
  });

  it("keeps bot page revision input bounded with a working neighboring request", () => {
    const rpc = WsRpcGroup.requests.get(WS_METHODS.botBrowserPage);
    if (rpc === undefined) throw new Error("Missing bot browser page");
    const decode = Schema.decodeUnknownExit(rpc.payloadSchema);
    expect(Exit.isSuccess(decode({ threadId: "thread-1", revision: "current" }))).toBe(true);
    expect(Exit.isFailure(decode({ threadId: "thread-1", revision: "x".repeat(129) }))).toBe(true);
  });

  it("allows only the explicit shell environment fields on desktop telemetry", () => {
    const decode = Schema.decodeUnknownSync(DesktopShellEnvironmentSnapshot);
    const decoded = decode({ version: 1, type: "shellEnvironment", discovered: true, platform: "windows",
      environment: { PATH: "C:/tools", LANG: "en_US", OPENAI_API_KEY: "synthetic-secret", arbitrarySecret: "synthetic-secret" },
    });
    expect(decoded.environment).toEqual({ PATH: "C:/tools", LANG: "en_US" });
    expect(JSON.stringify(decoded)).not.toContain("synthetic-secret");
  });
});
