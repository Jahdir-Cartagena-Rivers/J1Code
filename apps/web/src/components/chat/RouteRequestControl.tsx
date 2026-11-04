import { routeRequestAnchors } from "@t3tools/shared/routeRequestAnchors";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  manualRouteReasonLabel,
  manualRouteStatusLabel,
  EnvironmentId,
  ThreadId,
  ProjectId,
  type ManualRouteStatus,
} from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects, useThreadShells } from "../../state/entities";
import { Button } from "../ui/button";
import { Link } from "@tanstack/react-router";
import { buildThreadRouteParams } from "../../threadRoutes";

const EMPTY_MESSAGES: Parameters<typeof routeRequestAnchors>[1] = [];
const EMPTY_ACTIVITIES: Parameters<typeof routeRequestAnchors>[2] = [];

/** Only an explicit client action can redeem a destination confirmation. */
export function RouteRequestControl({
  environmentId,
  projectId,
  threadId,
  revision = 0,
  messages = EMPTY_MESSAGES,
  activities = EMPTY_ACTIVITIES,
  children,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  threadId: string;
  revision?: number;
  messages?: Parameters<typeof routeRequestAnchors>[1];
  activities?: Parameters<typeof routeRequestAnchors>[2];
  children?: (render: (messageId: string) => ReactNode) => ReactNode;
}) {
  const list = useAtomCommand(serverEnvironment.routingList, { reportFailure: false });
  const prepare = useAtomCommand(serverEnvironment.routingPrepare, { reportFailure: false });
  const confirm = useAtomCommand(serverEnvironment.routingConfirm, { reportFailure: false });
  const [requests, setRequests] = useState<ReadonlyArray<typeof ManualRouteStatus.Type>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeRequestId, setNoticeRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
  const projects = useProjects();
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId && thread.id !== threadId,
  );
  const refresh = useCallback(async () => {
    if (!threadId) return;
    const result = await list({
      environmentId,
      input: { source: { environmentId, projectId, threadId } },
    });
    if (result._tag === "Success") {
      setRequests((current) =>
        JSON.stringify(current) === JSON.stringify(result.value) ? current : result.value,
      );
      setNotice((value) => (value === "Could not load requests. Try again." ? "" : value));
    } else {
      setNoticeRequestId(null);
      setNotice("Could not load requests. Try again.");
    }
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
  const approve = async (requestId: string) => {
    const proposal = requests.find((request) => request.requestId === requestId)?.destination;
    const target = threads.find(
      (thread) => thread.id === proposal?.threadId && thread.archivedAt === null,
    );
    if (!target) return;
    setNoticeRequestId(requestId);
    setBusy(true);
    try {
      const prepared = await prepare({
        environmentId,
        input: {
          requestId,
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
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const anchors = routeRequestAnchors(requests, messages, activities);
  const render = (messageId?: string) => {
    const visible = messageId
      ? requests.filter((request) => anchors.get(request.requestId) === messageId)
      : requests;
    const pending = visible.filter((request) => request.status === "suggested");
    const selectedRequest =
      selected ?? pending.find((request) => !deferred.has(request.requestId))?.requestId;
    const relevantNotice =
      notice &&
      (noticeRequestId === null
        ? !messageId || messageId === messages.find((message) => message.role === "user")?.id
        : visible.some((request) => request.requestId === noticeRequestId));
    if (!visible.length) {
      if (
        noticeRequestId !== null ||
        !notice ||
        (messageId && messageId !== messages.find((message) => message.role === "user")?.id)
      )
        return null;
      return (
        <div role="status">
          {notice}
          <Button size="compact" variant="ghost" onClick={() => void refresh()}>
            Refresh requests
          </Button>
        </div>
      );
    }
    return (
      <section
        aria-label="Request approvals"
        className="mx-auto mb-3 w-full max-w-(--chat-max-width) rounded-xl border bg-card p-4 text-sm"
      >
        <div className="space-y-3">
          <h2 className="font-medium">
            {pending.length ? "Review handoff" : "Forwarded requests"}
          </h2>
          {visible.map((request) => (
            <div
              key={request.requestId}
              data-route-request-id={request.requestId}
              className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0"
            >
              <p className="whitespace-pre-wrap break-words">
                {request.summary || "Forwarded request"}
              </p>
              <p className="text-xs text-muted-foreground">
                {manualRouteStatusLabel(request.status)}
              </p>
              {request.destination && (
                <Link
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams({
                    environmentId: EnvironmentId.make(request.destination.environmentId),
                    threadId: ThreadId.make(request.destination.threadId),
                  })}
                  className="text-primary underline"
                >
                  {projectNames.get(ProjectId.make(request.destination.projectId)) ?? "Project"} /{" "}
                  {threads.find((thread) => thread.id === request.destination?.threadId)?.title ??
                    "Open destination chat"}
                </Link>
              )}
              {request.status === "suggested" && !request.destination && (
                <p>
                  No suitable working chat is available yet. Continue discussing the destination
                  here.
                </p>
              )}
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
                    setNotice("");
                  }}
                >
                  Review request
                </Button>
              )}
              {request.status === "suggested" && selectedRequest === request.requestId && (
                <>
                  <div className="flex gap-2">
                    <Button
                      size="compact"
                      disabled={
                        busy ||
                        !request.destination ||
                        !threads.some(
                          (thread) =>
                            thread.id === request.destination?.threadId &&
                            thread.archivedAt === null,
                        )
                      }
                      onClick={() => void approve(request.requestId)}
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
                      }}
                    >
                      Not now
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
          {relevantNotice && <p role="status">{notice}</p>}
          {relevantNotice && notice.includes("Could not load") && (
            <Button size="compact" variant="ghost" disabled={busy} onClick={() => void refresh()}>
              Refresh
            </Button>
          )}
        </div>
      </section>
    );
  };
  return children ? children(render) : render();
}
