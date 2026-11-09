type DropBox = { top: number; bottom: number; height: number };

/** Interpret before/after against the part of a bot row the person can actually reach. */
export function clipBotDropBox(
  row: DropBox,
  viewport?: Pick<DropBox, "top" | "bottom">,
): DropBox | null {
  if (!viewport) return row;
  const top = Math.max(row.top, viewport.top);
  const bottom = Math.min(row.bottom, viewport.bottom);
  return bottom > top ? { top, bottom, height: bottom - top } : null;
}

export function botDropBox(row: HTMLElement): DropBox | null {
  const scroller = row.closest<HTMLElement>("[data-j1-sidebar-scroll]");
  return clipBotDropBox(row.getBoundingClientRect(), scroller?.getBoundingClientRect());
}
