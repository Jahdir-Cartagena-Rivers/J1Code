import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function isDeepAIImageRejection(message: string) {
  return /multimodal processing is not enabled|(?:image|vision|multimodal).{0,60}(?:not supported|unsupported|not enabled)/i.test(
    message,
  );
}

/** Repair model context only; stored messages and original attachments remain intact. */
export function recoverDeepAIImageHistory(
  messages: AgentSession["messages"],
): AgentSession["messages"] {
  const rejected = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      message.stopReason === "error" &&
      isDeepAIImageRejection(message.errorMessage ?? ""),
  );
  if (rejected < 0) return messages;
  return messages.map((message, index) => {
    if (
      index > rejected ||
      (message.role !== "user" && message.role !== "toolResult") ||
      !Array.isArray(message.content)
    )
      return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "image"
          ? {
              type: "text" as const,
              text: "[Earlier image omitted from model context because DeepAI rejected image processing. The original remains attached in the chat.]",
            }
          : part,
      ),
    };
  });
}
