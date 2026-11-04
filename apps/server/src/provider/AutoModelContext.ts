/** Planning estimate, not a provider token count. Files are supplied by path and
 * read through tools, so their raw byte size must not be charged as image input.
 * Native sessions without usage stay on their current model until the provider
 * reports context again; visible history cannot account for hidden tool state.
 */
export function autoModelContext(input: {
  history: readonly { text: string; attachments?: readonly { type: string }[] | undefined }[];
  message: { text: string; attachments: readonly { type: string }[] };
  hasSession: boolean;
  usedTokens: number | null;
}) {
  const images = input.message.attachments.filter((item) => item.type === "image").length;
  const encoder = new TextEncoder();
  const validUsage =
    input.usedTokens !== null && Number.isSafeInteger(input.usedTokens) && input.usedTokens >= 0;
  const continuation = input.hasSession && (!validUsage || images > 0);
  const visibleTextBytes = encoder.encode(
    input.history.map((item) => item.text).join("\n") + input.message.text,
  ).length;
  const historicalImages = input.history.reduce(
    (count, item) =>
      count + (item.attachments?.filter((attachment) => attachment.type === "image").length ?? 0),
    0,
  );
  // A generous image allowance avoids pretending compressed file size is its
  // token cost. The provider still enforces real limits and manages compaction.
  const estimatedTokens =
    (input.hasSession && validUsage
      ? input.usedTokens! + encoder.encode(input.message.text).length
      : visibleTextBytes) +
    32768 +
    (images + (input.hasSession && validUsage ? 0 : historicalImages)) * 16384;
  return {
    estimatedTokens,
    requiresImages: images > 0 || (!input.hasSession && historicalImages > 0),
    requiredContextTokens: continuation ? null : estimatedTokens,
    continuation,
    estimated: images > 0 || historicalImages > 0 || !validUsage,
  };
}
