import { useMausbotWorkspaceState } from "./MausbotShell";
import { Button } from "./ui/button";
import { isMobileWorkspace, openMobileWorkspacePage } from "../mobileWorkspaceHost";

export function WorkspaceStatus() {
  const { error, busy, retry } = useMausbotWorkspaceState();
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-sm text-muted-foreground">
        <p role={error ? "alert" : "status"}>{error || "Opening your workspace…"}</p>
        {error ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={retry}>
              Try again
            </Button>
            {isMobileWorkspace() ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openMobileWorkspacePage("open-connections")}
              >
                Connections
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
