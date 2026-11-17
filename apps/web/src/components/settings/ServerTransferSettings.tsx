import { useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

function TransferCommand({ operation }: { operation: "export" | "import" }) {
  const [error, setError] = useState("");
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "transfer command",
    onCopy: () => setError(""),
    onError: () => setError("Could not copy. Select the command below to copy it manually."),
  });
  const command =
    "j1 transfer " +
    operation +
    " setup.j1-transfer --home-dir " +
    (operation === "export" ? "HOME" : "NEW_HOME") +
    " --password-file PASSWORD_FILE --stopped";
  return (
    <div className="min-w-0 space-y-2">
      <Button variant="outline" size="sm" onClick={() => copyToClipboard(command, undefined)}>
        {isCopied ? "Copied" : "Copy " + operation + " command"}
      </Button>
      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{command}</pre>
      {error && (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function ServerTransferSettings() {
  return (
    <SettingsSection id="server-transfer" title="Move this server">
      <div className="min-w-0 space-y-4 p-4 text-sm text-muted-foreground">
        <p>
          Move settings, conversations, bot history and attachments in one encrypted file. Stop J1,
          its background service and bots before exporting.
        </p>
        <p>
          Create a private password file with at least 12 characters. Replace HOME and PASSWORD_FILE
          in the command with their paths. Copy the archive to the new device and keep the password
          separate.
        </p>
        <TransferCommand operation="export" />
        <p>
          Install the matching J1 server on the new device. Import into a new, unused home folder,
          then start it with j1 serve --base-dir NEW_HOME. Keep the old server stopped: its identity
          and access permissions move with the data.
        </p>
        <TransferCommand operation="import" />
        <details>
          <summary className="cursor-pointer">What transfers?</summary>
          <p className="pt-2">
            Up to 64 GiB of server userdata, including secrets and bot configuration. Repositories,
            provider installations and external logins, operating-system services, network
            configuration and logs are excluded. Copy repositories separately and update their
            absolute paths. Machine-protected credentials may need re-entry.
          </p>
        </details>
      </div>
    </SettingsSection>
  );
}
