import { AuthSettingsWriteScope, type EnvironmentId } from "@j1code/contracts";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export function EnableCursorUsage({ environmentId, label, onEnabled }: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
}) {
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const save = useAtomCommand(serverEnvironment.updateSettings);
  const [saving, setSaving] = useState(false);
  return <Button label={`Enable Cursor usage on ${label}`} disabled={!allowed || saving}
    loading={saving} onPress={() => {
      if (!allowed || saving) return;
      setSaving(true);
      void save({ environmentId, input: { patch: { cursorKeychainUsageEnabled: true } } })
        .then((result) => { if (result._tag === "Success") onEnabled(); })
        .finally(() => setSaving(false));
    }} />;
}
