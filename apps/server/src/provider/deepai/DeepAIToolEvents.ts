import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ItemLifecyclePayload } from "@t3tools/contracts";

function output(value: unknown): string {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content))
    return "";
  return value.content
    .flatMap((part: unknown) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
    .slice(-4000);
}

/** Bounded canonical activity, separate from the provider's full local transcript. */
export function deepAIToolEvent(
  event: AgentSessionEvent,
  rememberedCommand?: string,
):
  | {
      type: "item.started" | "item.updated" | "item.completed";
      callId: string;
      payload: ItemLifecyclePayload;
    }
  | undefined {
  if (
    event.type !== "tool_execution_start" &&
    event.type !== "tool_execution_update" &&
    event.type !== "tool_execution_end"
  )
    return;
  const name = event.toolName;
  const args: unknown = "args" in event ? event.args : undefined;
  const command =
    args && typeof args === "object" && "command" in args && typeof args.command === "string"
      ? args.command.slice(0, 512)
      : rememberedCommand;
  const detail = command ?? name;
  const text = output(
    event.type === "tool_execution_end"
      ? event.result
      : event.type === "tool_execution_update"
        ? event.partialResult
        : undefined,
  );
  return {
    type:
      event.type === "tool_execution_start"
        ? "item.started"
        : event.type === "tool_execution_update"
          ? "item.updated"
          : "item.completed",
    callId: event.toolCallId,
    payload: {
      itemType:
        name === "bash" || name === "powershell"
          ? "command_execution"
          : name === "edit" || name === "write"
            ? "file_change"
            : "dynamic_tool_call",
      status:
        event.type === "tool_execution_end"
          ? event.isError
            ? "failed"
            : "completed"
          : "inProgress",
      title: name,
      detail,
      data: {
        toolCallId: event.toolCallId,
        toolName: name,
        ...(command && (name === "bash" || name === "powershell") ? { command } : {}),
        ...(text ? { rawOutput: { content: text } } : {}),
      },
    },
  };
}
