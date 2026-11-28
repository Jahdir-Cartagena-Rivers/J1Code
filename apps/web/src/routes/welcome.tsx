import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@j1code/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { resolveWelcomeEnvironment } from "../onboarding/welcomePage.logic";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomePage } from "../components/onboarding/WelcomePage";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  // A ChatGPT sign-in returns here with the computer it set up.
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady } = useEnvironments();
  const waitingForCatalog =
    !isReady && (resumeEnvironmentId !== undefined || primaryEnvironmentId === null);
  const environmentId = resolveWelcomeEnvironment({
    primaryEnvironmentId,
    resumeEnvironmentId,
    knownEnvironmentIds: environments.map((environment) => environment.environmentId),
  });
  // The root can remount this pending outlet after navigation; do not reopen setup.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();
  if (waitingForCatalog) return null;
  if (resumeEnvironmentId !== undefined && environmentId === null && isWelcomeRoute && !dismissed) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Waiting for the selected computer to reconnect. Setup will stay on that computer.
      </div>
    );
  }
  if (environmentId === null || !isWelcomeRoute || dismissed) return <NoProjectsHero />;
  return (
    <WelcomePage
      key={environmentId}
      environmentId={environmentId}
      onDone={async (projectRef, destination) => {
        setDismissed(true);
        if (destination === "assistants") {
          await navigate({ to: "/assistants", search: { environmentId }, replace: true });
          return;
        }
        if (projectRef !== undefined) {
          await openNewThread(projectRef, { replace: true }).catch(() =>
            navigate({ to: "/", replace: true }),
          );
          return;
        }
        await navigate({ to: "/", replace: true });
      }}
    />
  );
}
