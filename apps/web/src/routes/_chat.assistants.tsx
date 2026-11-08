import { createFileRoute } from "@tanstack/react-router";
import { useMausbotWorkspaceState } from "../components/MausbotShell";
import { Button } from "../components/ui/button";
import { EnvironmentId } from "@t3tools/contracts";

export const Route = createFileRoute("/_chat/assistants")({
  component: WorkspaceStatus,
  validateSearch: (
    input: Record<string, unknown>,
  ): { environmentId?: EnvironmentId; botId?: string; conversation?: string } => {
    const id = /^[A-Za-z0-9_-]{1,120}$/;
    const environment =
      typeof input.environmentId === "string" &&
      input.environmentId.length > 0 &&
      input.environmentId.length <= 200
        ? { environmentId: EnvironmentId.make(input.environmentId) }
        : {};
    return typeof input.botId === "string" &&
      id.test(input.botId) &&
      typeof input.conversation === "string" &&
      id.test(input.conversation)
      ? { botId: input.botId, conversation: input.conversation, ...environment }
      : environment;
  },
});

function WorkspaceStatus() {
  const { error, busy, retry } = useMausbotWorkspaceState();
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-sm text-muted-foreground">
        <p role={error ? "alert" : "status"}>{error || "Opening your workspace…"}</p>
        {error && (
          <Button variant="outline" size="sm" disabled={busy} onClick={retry}>
            Try again
          </Button>
        )}
      </div>
    </main>
  );
}
