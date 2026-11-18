export type FrameRect = { left: number; top: number; width: number; height: number };
export type FrameOverlay = FrameRect & { mainOnly?: boolean };

/** The phone drawer covers the work pane, while project navigation remains inside that drawer. */
export function nativeOverlayClip(
  box: FrameRect,
  reported: readonly FrameOverlay[],
  pane: "main" | "navigation" = "main",
) {
  const overlays = reported.filter((rect) => pane === "main" || rect.mainOnly !== true);
  if (
    overlays.some(
      (rect) =>
        rect.left <= box.left &&
        rect.top <= box.top &&
        rect.left + rect.width >= box.left + box.width &&
        rect.top + rect.height >= box.top + box.height,
    )
  )
    return "inset(50%)";
  const holes = overlays.flatMap((rect) => {
    if (
      rect.left + rect.width <= box.left ||
      rect.left >= box.left + box.width ||
      rect.top + rect.height <= box.top ||
      rect.top >= box.top + box.height
    )
      return [];
    const left = Math.max(0, rect.left - box.left - 8);
    const right = Math.min(box.width, rect.left + rect.width - box.left + 8);
    const top = Math.max(0, rect.top - box.top - 8);
    const bottom = Math.min(box.height, rect.top + rect.height - box.top + 8);
    return right > left && bottom > top ? [`M${left} ${top}H${right}V${bottom}H${left}Z`] : [];
  });
  return holes.length
    ? `path(evenodd, "M0 0H${box.width}V${box.height}H0Z${holes.join("")}")`
    : undefined;
}
