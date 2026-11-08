// Adapted from OpenMausBot src/components/SkinPicker.tsx, Apache-2.0.
// Source d818c28aa80686dc1d7db64ebeffa2a9dc468762. See LICENSE and NOTICE in this directory.
import type { ThemeColors } from "../../themePalette";

/** Upstream's static miniature, using the existing J1 palette roles for custom themes too. */
export function ThemeMiniature({ colors }: { colors: ThemeColors }) {
  const faint = (amount: number) => `color-mix(in srgb, ${colors.text} ${amount}%, transparent)`;
  return (
    <div
      aria-hidden="true"
      className="flex h-19.5 w-full overflow-hidden rounded-lg"
      style={{ background: colors.canvas, boxShadow: `0 0 0 1px ${colors.border}` }}
    >
      <div
        className="flex w-2.75 shrink-0 flex-col items-center gap-0.75 pt-1.25"
        style={{ background: colors.chrome }}
      >
        <span className="size-1.25 rounded-full" style={{ background: colors.accent }} />
        <span className="size-1.25 rounded-full" style={{ background: faint(40) }} />
        <span className="size-1.25 rounded-full" style={{ background: faint(40) }} />
      </div>
      <div
        className="flex w-7.5 shrink-0 flex-col gap-0.75 border-r p-1"
        style={{ background: colors.sidebar, borderColor: colors.border }}
      >
        <span
          className="flex h-[9px] w-full items-center gap-0.5 rounded-sm px-0.5"
          style={{ background: colors.surfaceRaised }}
        >
          <span className="size-1 shrink-0 rounded-full" style={{ background: colors.accent }} />
          <span className="h-0.5 flex-1 rounded-full" style={{ background: faint(50) }} />
        </span>
        <span className="h-0.75 w-[80%] rounded-full" style={{ background: faint(30) }} />
        <span className="h-0.75 w-[62%] rounded-full" style={{ background: faint(30) }} />
        <span className="h-0.75 w-[74%] rounded-full" style={{ background: faint(30) }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
        <span
          className="h-3.25 w-[62%] self-end rounded-md"
          style={{ background: colors.messageSurface }}
        />
        <div
          className="flex w-[88%] flex-col gap-0.75 rounded-md p-1"
          style={{ background: colors.surface }}
        >
          <span className="h-0.5 w-full rounded-full" style={{ background: faint(45) }} />
          <span className="h-0.5 w-[85%] rounded-full" style={{ background: faint(45) }} />
          <span className="h-0.5 w-[60%] rounded-full" style={{ background: faint(40) }} />
        </div>
        <div className="mt-auto flex items-center gap-1">
          <span
            className="h-2.75 flex-1 rounded-full"
            style={{ background: colors.muted, boxShadow: `0 0 0 1px ${colors.border}` }}
          />
          <span
            className="flex size-2.75 items-center justify-center rounded-full"
            style={{ background: colors.accent }}
          >
            <span
              className="h-[1.5px] w-1.25 rounded-full"
              style={{ background: colors.accentForeground }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}
