/** Routine runs remain separately accessible and do not replace a bot's regular conversation. */
export function latestBotConversation<
  T extends {
    readonly id: string;
    readonly environmentId: string;
    readonly bot?: { readonly id: string } | null;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  },
>(threads: ReadonlyArray<T>, environmentId: string, botId: string): T | undefined {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.bot?.id === botId &&
        thread.archivedAt === null &&
        !thread.id.startsWith("bot-routine:"),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
