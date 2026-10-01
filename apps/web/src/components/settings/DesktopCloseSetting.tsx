import { useState } from "react";
import type { DesktopCloseBehavior } from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const choices = { ask: "Ask every time", tray: "Close to tray", quit: "Close completely" } as const;

export function DesktopCloseSetting() {
  const bridge = window.desktopBridge;
  const [behavior, setBehavior] = useState<DesktopCloseBehavior>(
    () => bridge?.getCloseBehavior?.() ?? "ask",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (bridge?.getClientPlatform?.() !== "win32" || !bridge.setCloseBehavior) return null;
  const save = async (value: DesktopCloseBehavior) => {
    setBusy(true);
    setError(null);
    try {
      await bridge.setCloseBehavior!(value);
      setBehavior(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save close preference.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      {...searchableSetting("desktop-close-behavior")}
      description={
        error ?? "Closing to tray keeps chats running. Closing completely stops J1 and its server."
      }
      control={
        <Select
          value={behavior}
          disabled={busy}
          onValueChange={(value) => {
            if (value === "ask" || value === "tray" || value === "quit") void save(value);
          }}
        >
          <SelectTrigger aria-label="When closing J1 Code">
            <SelectValue>{choices[behavior]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(choices).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
