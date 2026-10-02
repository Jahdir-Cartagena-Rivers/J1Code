import { createFileRoute } from "@tanstack/react-router";

import { DotChatView } from "../components/dot/DotChatView";
import { usePrimaryEnvironmentId } from "../state/environments";

function DotRoute() {
  const environmentId = usePrimaryEnvironmentId();
  return <DotChatView key={environmentId ?? "unpaired"} />;
}

export const Route = createFileRoute("/_chat/dot")({
  component: DotRoute,
});
