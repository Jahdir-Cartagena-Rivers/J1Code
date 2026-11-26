/** Keep a renewed frame mounted. A replacement requires a fresh authenticated host call. */
export async function recoverMausbotView(
  renew: () => Promise<boolean>,
  open: () => Promise<string | null>,
  isCurrent: () => boolean,
): Promise<string | null> {
  try {
    if (!isCurrent() || (await renew()) || !isCurrent()) return null;
    const replacement = await open();
    return isCurrent() ? replacement : null;
  } catch {
    // A transport error can be retried when the window regains focus or reconnects.
    return null;
  }
}
