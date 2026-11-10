import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function DeepAISetupSection(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  authenticated: boolean;
  disabled: boolean;
}) {
  const target = { environmentId: props.environmentId, input: { instanceId: props.instanceId } };
  const state = useEnvironmentQuery(serverEnvironment.providerAuthState(target)).data;
  const start = useAtomCommand(serverEnvironment.startProviderAuth);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth);
  const [pending, setPending] = useState(false);
  const active =
    pending ||
    state?.phase === "starting" ||
    state?.phase === "waiting" ||
    state?.phase === "verifying";
  return (
    <section aria-label="DeepAI setup">
      <SettingsRow
        title="DeepAI account"
        description="Import the account already signed in to DeepAI Code on this server. This does not open a sign-in window. Signing out here leaves DeepAI Code signed in."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={props.disabled || active}
            onClick={async () => {
              setPending(true);
              try {
                if (props.authenticated) await logout(target);
                else
                  await start({
                    environmentId: props.environmentId,
                    input: { instanceId: props.instanceId, methodId: "import" },
                  });
              } finally {
                setPending(false);
              }
            }}
          >
            {active
              ? "Working…"
              : props.authenticated
                ? "Sign out of DeepAI"
                : "Import DeepAI Code account"}
          </Button>
        }
      />
      {state?.message ? (
        <p className="px-4 py-2 text-xs text-muted-foreground" role="status">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
