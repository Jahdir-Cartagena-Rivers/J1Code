import { createFileRoute } from "@tanstack/react-router";
import { useMausbotWorkspaceState } from "../components/MausbotShell";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/_chat/assistants")({ component: WorkspaceStatus });

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
