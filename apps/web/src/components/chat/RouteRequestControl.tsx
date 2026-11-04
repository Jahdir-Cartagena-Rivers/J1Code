import { useCallback, useEffect, useState } from "react";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** Only an explicit client action can redeem a destination confirmation. */
export function RouteRequestControl({
  environmentId,
  projectId,
  threadId,
  revision = 0,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  threadId: string;
  revision?: number;
}) {
  const list = useAtomCommand(serverEnvironment.routingList, { reportFailure: false });
  const prepare = useAtomCommand(serverEnvironment.routingPrepare, { reportFailure: false });
  const confirm = useAtomCommand(serverEnvironment.routingConfirm, { reportFailure: false });
  const [requests, setRequests] = useState<ReadonlyArray<typeof ManualRouteStatus.Type>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
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
    void Promise.resolve().then(refresh);
    // Source routing activities refresh immediately; this also reconciles older
    // servers and statuses after reconnect without polling hidden clients.
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
    // Source revision invalidates this read; it is not part of the RPC payload.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [refresh, revision]);
  const pending = requests.filter((request) => request.status === "suggested");
  const selectedRequest =
    selected ?? pending.find((request) => !deferred.has(request.requestId))?.requestId;
  const selectedDestination =
    destination ??
    requests.find((request) => request.requestId === selectedRequest)?.destination?.threadId ??
    null;
  const approve = async () => {
    const target = threads.find((thread) => thread.id === selectedDestination);
    if (!selectedRequest || !target) return;
    setBusy(true);
    try {
      const prepared = await prepare({
        environmentId,
        input: {
          requestId: selectedRequest,
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
  if (!requests.length && !revision) return null;
  return (
    <section
      aria-label="Request approvals"
      className="mx-auto mb-3 w-full max-w-(--chat-max-width) rounded-xl border bg-card p-4 text-sm"
    >
      <div className="max-h-80 space-y-3 overflow-y-auto">
        <h2 className="font-medium">{pending.length ? "Review handoff" : "Forwarded requests"}</h2>
        {!requests.length && <p>No requests in this conversation.</p>}
        {[...pending, ...requests.filter((request) => request.status !== "suggested")].map(
          (request) => (
            <div
              key={request.requestId}
              className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0"
            >
              <p className="whitespace-pre-wrap break-words">
                {request.summary || "Forwarded request"}
              </p>
              <p className="text-xs text-muted-foreground">
                {manualRouteStatusLabel(request.status)}
                {request.status !== "suggested" &&
                  request.destination &&
                  ` · ${threads.find((thread) => thread.id === request.destination?.threadId)?.title ?? "Destination unavailable"}`}
              </p>
              {request.reason && request.reason !== "ambiguous-destination" && (
                <p className="text-xs text-muted-foreground">
                  {manualRouteReasonLabel(request.reason)}
                </p>
              )}
              {request.status === "suggested" && selectedRequest !== request.requestId && (
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
              {request.status === "suggested" && selectedRequest === request.requestId && (
                <>
                  <Select
                    items={threads.map((thread) => ({
                      value: thread.id,
                      label: `${projectNames.get(thread.projectId) ?? "Project"} / ${thread.title}`,
                    }))}
                    value={selectedDestination}
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
                      disabled={
                        busy || !threads.some((thread) => thread.id === selectedDestination)
                      }
                      onClick={() => void approve()}
                    >
                      Approve and send
                    </Button>
                    <Button
                      size="compact"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setDeferred((current) => new Set([...current, request.requestId]));
                        setSelected(null);
                        setDestination(null);
                      }}
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
        {notice.includes("Could not load") && (
          <Button size="compact" variant="ghost" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        )}
      </div>
    </section>
  );
}
