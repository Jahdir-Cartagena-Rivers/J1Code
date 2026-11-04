import type { ThreadBotIdentity } from "@t3tools/contracts";

export function botTurnContext(bot: ThreadBotIdentity | null | undefined): string {
  if (!bot) return "";
  const profile = JSON.stringify({ name: bot.name, instructions: bot.instructions }).replaceAll(
    "<",
    "\\u003c",
  );
  return `User-configured bot profile for this conversation:\n${profile}\n\n`;
}
