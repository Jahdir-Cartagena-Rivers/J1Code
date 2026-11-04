import { useCallback, useEffect, useState } from "react";
import { InboxIcon } from "lucide-react";
import {
  manualRouteReasonLabel,
  manualRouteStatusLabel,
  type EnvironmentId,
  type ManualRouteStatus,
} from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects, useThreadShells } from "../../state/entities";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** Only an explicit client action can redeem a destination confirmation. */
export function RouteRequestControl({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  threadId: string;
}) {
  const list = useAtomCommand(serverEnvironment.routingList, { reportFailure: false });
  const prepare = useAtomCommand(serverEnvironment.routingPrepare, { reportFailure: false });
  const confirm = useAtomCommand(serverEnvironment.routingConfirm, { reportFailure: false });
  const [requests, setRequests] = useState<ReadonlyArray<typeof ManualRouteStatus.Type>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const projects = useProjects();
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      thread.id !== threadId,
  );
  const refresh = useCallback(async () => {
    const result = await list({
      environmentId,
      input: { source: { environmentId, projectId, threadId } },
    });
    if (result._tag === "Success") {
      setRequests(result.value);
      setNotice((value) => (value === "Could not load requests. Try again." ? "" : value));
    } else setNotice("Could not load requests. Try again.");
  }, [environmentId, projectId, threadId, list]);
  useEffect(() => {
    let disposed = false;
    const update = () => {
      if (!disposed && document.visibilityState === "visible") void refresh();
    };
    update();
    // Routing receipts are not part of the chat stream. Refresh only visible clients,
    // with one small source-scoped request, never one request per saved conversation.
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);
  const pending = requests.filter((request) => request.status === "suggested");
  const approve = async () => {
    const target = threads.find((thread) => thread.id === destination);
    if (!selected || !target) return;
    setBusy(true);
    try {
      const prepared = await prepare({
        environmentId,
        input: {
          requestId: selected,
          source: { environmentId, projectId, threadId },
          destination: { environmentId, projectId: target.projectId, threadId: target.id },
        },
      });
      if (prepared._tag === "Failure") {
        setNotice("This request changed or the conversation is unavailable. Review it again.");
        await refresh();
        return;
      }
      const result = await confirm({ environmentId, input: { token: prepared.value.token } });
      setNotice(
        result._tag === "Success"
          ? `Queued for ${target.title}. Delivery and acceptance will appear below.`
          : "Could not approve this request. It may have changed; review it again.",
      );
      if (result._tag === "Success") {
        setSelected(null);
        setDestination(null);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0">
      <Popover
        onOpenChange={(open) => {
          if (open) void refresh();
        }}
      >
        <PopoverTrigger
          render={
            <Button
              size="compact"
              title="Requests"
              variant={pending.length ? "outline" : "ghost"}
              aria-label={
                pending.length ? `Requests: ${pending.length} awaiting approval` : "Requests"
              }
            />
          }
        >
          <InboxIcon />
          {pending.length > 0 ? pending.length : null}
        </PopoverTrigger>
        <PopoverPopup width="lg" side="bottom" align="end">
          <div className="max-h-96 space-y-3 overflow-y-auto text-sm">
            <h2 className="font-medium">Requests</h2>
            <p className="text-xs text-muted-foreground">
              Approve where uncertain matches belong. Your original conversation stays here.
            </p>
            {!requests.length && <p>No requests in this conversation.</p>}
            {[...pending, ...requests.filter((request) => request.status !== "suggested")].map(
              (request) => (
                <div key={request.requestId} className="space-y-2 rounded-md border p-3">
                  <p className="whitespace-pre-wrap break-words">
                    {request.summary || "Forwarded request"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {manualRouteStatusLabel(request.status)}
                    {request.destination &&
                      ` · ${threads.find((thread) => thread.id === request.destination?.threadId)?.title ?? "Destination unavailable"}`}
                  </p>
                  {request.reason && (
                    <p className="text-xs text-muted-foreground">
                      {manualRouteReasonLabel(request.reason)}
                    </p>
                  )}
                  {request.status === "suggested" && selected !== request.requestId && (
                    <Button
                      size="compact"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setSelected(request.requestId);
                        setDestination(request.destination?.threadId ?? null);
                        setNotice("");
                      }}
                    >
                      Review request
                    </Button>
                  )}
                  {request.status === "suggested" && selected === request.requestId && (
                    <>
                      <Select
                        items={threads.map((thread) => ({
                          value: thread.id,
                          label: `${projectNames.get(thread.projectId) ?? "Project"} / ${thread.title}`,
                        }))}
                        value={destination}
                        onValueChange={setDestination}
                      >
                        <SelectTrigger aria-label="Destination conversation">
                          <SelectValue placeholder="Choose a conversation" />
                        </SelectTrigger>
                        <SelectPopup>
                          {threads.map((thread) => (
                            <SelectItem key={thread.id} value={thread.id}>
                              {projectNames.get(thread.projectId) ?? "Project"} / {thread.title}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <div className="flex gap-2">
                        <Button
                          size="compact"
                          disabled={busy || !threads.some((thread) => thread.id === destination)}
                          onClick={() => void approve()}
                        >
                          Approve and send
                        </Button>
                        <Button
                          size="compact"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setSelected(null)}
                        >
                          Not now
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ),
            )}
            {notice && <p role="status">{notice}</p>}
            <Button size="compact" variant="ghost" disabled={busy} onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
