/** Handoff links are relative so the same conversation works through local, remote and relay origins. */
export function parseProjectChatLink(
  href: string,
): { environmentId: string; threadId: string } | null {
  const match =
    /^\/([^/?#]+)\/(j1-handoff-[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
      href,
    );
  if (!match) return null;
  try {
    const environmentId = decodeURIComponent(match[1]!);
    return environmentId && !/[\s/\\]/.test(environmentId)
      ? { environmentId, threadId: match[2]! }
      : null;
  } catch {
    return null;
  }
}
