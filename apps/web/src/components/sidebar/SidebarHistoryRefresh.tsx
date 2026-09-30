import { RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { agentSessionImport } from "../../state/agentSessions";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Explicitly reread saved Claude/Codex transcripts on their owning environments. */
export function SidebarHistoryRefresh() {
  const projects = useProjects();
  const importHistory = useAtomCommand(agentSessionImport, { reportFailure: false });
  const pending = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    if (pending.current || projects.length === 0) return;
    pending.current = true;
    setRefreshing(true);
    let checked = 0;
    let skipped = 0;
    let failed = 0;
    try {
      for (const project of projects) {
        const result = await importHistory({
          environmentId: project.environmentId,
          input: { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
        });
        if (result._tag === "Success") {
          checked += result.value.importedCount;
          skipped += result.value.skippedCount;
        } else {
          failed += 1;
        }
      }
      toastManager.add(
        stackedThreadToast({
          type: failed > 0 || skipped > 0 ? "warning" : "success",
          title:
            failed > 0 || skipped > 0 ? "History refresh partly completed" : "History refreshed",
          description: `${checked} saved conversations checked. ${skipped} could not be refreshed; ${failed} project reads failed. Chats continued in J1 Code or with changed source history are preserved.`,
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not refresh history",
          description:
            error instanceof Error ? error.message : "The history read failed. Try again.",
        }),
      );
    } finally {
      pending.current = false;
      setRefreshing(false);
    }
  };

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              size="icon"
              aria-label={refreshing ? "Refreshing history" : "Refresh history"}
              aria-busy={refreshing}
              disabled={refreshing || projects.length === 0}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">
          {refreshing
            ? "Refreshing history…"
            : "Refresh saved history · Live viewing: Settings → General"}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
