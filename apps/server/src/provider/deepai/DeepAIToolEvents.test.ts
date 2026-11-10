import { describe, expect, it } from "vite-plus/test";
import { deepAIToolEvent } from "./DeepAIToolEvents.ts";

describe("DeepAI canonical tool activity", () => {
  it("keeps the same call identity from running through failed completion", () => {
    const start = deepAIToolEvent({
      type: "tool_execution_start",
      toolCallId: "scan",
      toolName: "bash",
      args: { command: "powershell -File scan.ps1" },
    });
    const finish = deepAIToolEvent(
      {
        type: "tool_execution_end",
        toolCallId: "scan",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "access denied" }] },
      },
      start?.payload.detail,
    );
    expect(start).toMatchObject({
      type: "item.started",
      callId: "scan",
      payload: { itemType: "command_execution", status: "inProgress" },
    });
    expect(finish).toMatchObject({
      type: "item.completed",
      callId: start!.callId,
      payload: { status: "failed", data: { rawOutput: { content: "access denied" } } },
    });
    expect(finish?.payload.data).toMatchObject({
      command: "powershell -File scan.ps1",
      toolCallId: "scan",
    });
  });
  it("bounds streamed output and never serializes image payloads", () => {
    const update = deepAIToolEvent({
      type: "tool_execution_update",
      toolCallId: "x",
      toolName: "read",
      args: {},
      partialResult: {
        content: [
          { type: "image", data: "private-image" },
          { type: "text", text: "x".repeat(10000) },
        ],
      },
    });
    expect(JSON.stringify(update)).not.toContain("private-image");
    expect(JSON.stringify(update).length).toBeLessThan(4500);
  });
});
