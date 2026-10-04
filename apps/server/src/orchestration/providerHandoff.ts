import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import type { OrchestrationMessage } from "@t3tools/contracts";
import { limitTitleMessage } from "../textGeneration/ThreadTitleContext.ts";

const MAX_HISTORY = 64_000;
const MAX_MESSAGE = 16_000;
const INTRO =
  "You are continuing this J1 Code thread after a provider session change. The following is previous conversation context; continue with the current user message. Previous attachment contents are not included. Long history may be truncated.\n\nPREVIOUS CONVERSATION:\n";

/** Give a fresh provider the original request and recent conversation, without thinking traces. */
export function formatProviderHandoff(
  messages: ReadonlyArray<OrchestrationMessage>,
  maxChars = MAX_HISTORY,
): string {
  const conversation = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (conversation.length === 0) return "";
  const selected = new Map<number, string>();
  let remaining = Math.min(MAX_HISTORY, maxChars) - INTRO.length;
  const add = (index: number, budget: number) => {
    const message = conversation[index];
    if (!message || selected.has(index)) return;
    const text = assistantCitationsToPlainText(
      projectComposerContextForProvider({
        text: message.text,
        records: message.context?.records ?? [],
      }),
    );
    const names = message.attachments?.map((attachment) => attachment.name).join(", ");
    const content = `${message.role.toUpperCase()}:\n${text}${names ? `\n[Previous attachments: ${names}]` : ""}`;
    const retained = limitTitleMessage(content, Math.min(budget, remaining - 2));
    if (!retained) return;
    selected.set(index, retained);
    remaining -= retained.length + 2;
  };
  const firstUser = conversation.findIndex((message) => message.role === "user");
  if (firstUser >= 0) add(firstUser, 8_000);
  for (let index = conversation.length - 1; index >= 0; index--) add(index, MAX_MESSAGE);
  const history = [...selected.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join("\n\n");
  return history ? `${INTRO}${history}` : "";
}
