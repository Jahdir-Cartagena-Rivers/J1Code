import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";
import { useMergedSettingsAppearance } from "./settingsAppearance";

/** Shared settings card surface, with optional separators between rows. */
export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
}) {
  const merged = useMergedSettingsAppearance();
  return (
    <div
      {...props}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped"
          ? merged
            ? "rounded-xl bg-card"
            : "rounded-xl border border-border/60 bg-card/40 shadow-xs/5"
          : "space-y-1",
        variant === "grouped" &&
          divided &&
          "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    />
  );
}
