import { AuthSettingsWriteScope, type EnvironmentId } from "@j1code/contracts";
import { useState } from "react";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";

export function EnableCursorUsage({ environmentId, label, onEnabled }: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
}) {
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [saving, setSaving] = useState(false);
  return (
    <Button variant="outline" size="sm" disabled={!allowed || saving} onClick={() => {
      if (!allowed || saving) return;
      setSaving(true);
      updateSettings({ cursorKeychainUsageEnabled: true }, {
        onSaved: () => { setSaving(false); onEnabled(); },
        onFailed: () => setSaving(false),
      });
    }}>
      Enable Cursor usage on {label}
    </Button>
  );
}
