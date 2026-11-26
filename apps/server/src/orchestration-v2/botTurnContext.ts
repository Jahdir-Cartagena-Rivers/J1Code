import type { MessageId, ThreadBotIdentity, ThreadId } from "@j1code/contracts";
import type { CapturedBotExecutionContext } from "../mausbot/ExecutionContext.ts";

export function botTurnContext(bot: ThreadBotIdentity | null | undefined): string {
  if (!bot) return "";
  const profile = JSON.stringify({ name: bot.name, instructions: bot.instructions }).replaceAll(
    "<",
    "\\u003c",
  );
  return `User-configured bot profile for this conversation:\n${profile}\n\n`;
}

export function isMausBotExecutionThread(threadId: string): boolean {
  return threadId.startsWith("j1-mausbot:");
}

export function resolveBotTurnContext(
  thread: { readonly id: ThreadId; readonly bot?: ThreadBotIdentity },
  messageId: MessageId,
  captured: CapturedBotExecutionContext | undefined,
) {
  const profile = botTurnContext(thread.bot);
  if (!isMausBotExecutionThread(thread.id))
    return { type: "profile" as const, prompt: profile };
  const owner = captured?.owner;
  if (!captured || captured.threadId !== thread.id || !owner ||
      owner.messageId !== messageId || !captured.isCurrent() ||
      !thread.id.startsWith(`j1-mausbot:${owner.botId}:`) ||
      (thread.bot && thread.bot.id !== owner.botId && thread.bot.id !== `mausbot:${owner.botId}`)) {
    return { type: "stale" as const };
  }
  return { type: "bridge" as const, context: captured, prompt: [profile.trimEnd(), captured.prompt].filter(Boolean).join("\n\n") };
}
