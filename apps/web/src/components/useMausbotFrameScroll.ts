import { useEffect, type RefObject } from "react";

/** A cross-origin form is painted over its native slot; the native page still owns scrolling. */
export function useMausbotFrameScroll(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  scroll: (delta: number) => void,
) {
  useEffect(() => {
    const content = ref.current;
    if (!enabled || !content) return;
    const innerScrolls = (target: EventTarget | null, delta: number) => {
      let node = target instanceof Element ? target : null;
      while (node && node !== content) {
        if (
          node instanceof HTMLElement &&
          /auto|scroll/.test(getComputedStyle(node).overflowY) &&
          node.scrollHeight > node.clientHeight &&
          (delta < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight)
        )
          return true;
        node = node.parentElement;
      }
      return false;
    };
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        innerScrolls(event.target, event.deltaY)
      )
        return;
      event.preventDefault();
      scroll(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1));
    };
    let touch: { x: number; y: number } | null = null;
    const start = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      touch = point ? { x: point.clientX, y: point.clientY } : null;
    };
    const move = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!point || !touch) return;
      const delta = touch.y - point.clientY;
      if (
        Math.abs(delta) >= Math.abs(touch.x - point.clientX) &&
        !innerScrolls(event.target, delta)
      ) {
        event.preventDefault();
        scroll(delta);
      }
      touch = { x: point.clientX, y: point.clientY };
    };
    content.addEventListener("wheel", wheel, { passive: false });
    content.addEventListener("touchstart", start, { passive: true });
    content.addEventListener("touchmove", move, { passive: false });
    return () => {
      content.removeEventListener("wheel", wheel);
      content.removeEventListener("touchstart", start);
      content.removeEventListener("touchmove", move);
    };
  }, [ref, enabled, scroll]);
}
