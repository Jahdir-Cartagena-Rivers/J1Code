import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceStatus } from "../components/WorkspaceStatus";
import { EnvironmentId, mausbotSavedAppLaunchUrl } from "@j1code/contracts";

export const Route = createFileRoute("/_chat/assistants")({
  component: WorkspaceStatus,
  validateSearch: (
    input: Record<string, unknown>,
  ): {
    environmentId?: EnvironmentId;
    botId?: string;
    conversation?: string;
    savedApp?: string;
  } => {
    const id = /^[A-Za-z0-9_-]{1,120}$/;
    const environment =
      typeof input.environmentId === "string" &&
      input.environmentId.length > 0 &&
      input.environmentId.length <= 200
        ? { environmentId: EnvironmentId.make(input.environmentId) }
        : {};
    if (typeof input.savedApp === "string" && mausbotSavedAppLaunchUrl(input.savedApp) !== null) {
      return { savedApp: input.savedApp };
    }
    return typeof input.botId === "string" &&
      id.test(input.botId) &&
      typeof input.conversation === "string" &&
      id.test(input.conversation)
      ? { botId: input.botId, conversation: input.conversation, ...environment }
      : environment;
  },
});
