import { routeRequestAnchors } from "@t3tools/shared/routeRequestAnchors";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppState, Pressable, View } from "react-native";
import { Option } from "effect";
import {
  ThreadId,
  manualRouteReasonLabel,
  manualRouteStatusLabel,
  type EnvironmentId,
  type ManualRouteStatus,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";

export function MobileRouteRequests({
  environmentId,
  projectId,
  threadId,
  children,
  messages,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  threadId: string;
  messages?: Parameters<typeof routeRequestAnchors>[1];
  children?: (render: (messageId: string) => ReactNode) => ReactNode;
}) {
  const navigation = useNavigation();
  const list = useAtomCommand(serverEnvironment.routingList, { reportFailure: false });
  const prepare = useAtomCommand(serverEnvironment.routingPrepare, { reportFailure: false });
  const confirm = useAtomCommand(serverEnvironment.routingConfirm, { reportFailure: false });
  const projects = useProjects();
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId && thread.id !== threadId,
  );
  const detail = useEnvironmentThread(environmentId, ThreadId.make(threadId));
  const revision =
    Option.getOrNull(detail.data)?.activities.filter(
      (activity) => activity.kind === "routing.updated",
    ).length ?? 0;
  const [requests, setRequests] = useState<ReadonlyArray<typeof ManualRouteStatus.Type>>([]);
  const [notice, setNotice] = useState("");
  const [noticeRequestId, setNoticeRequestId] = useState<string | null>(null);
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const result = await list({
      environmentId,
      input: { source: { environmentId, projectId, threadId } },
    });
    if (result._tag === "Success")
      setRequests((current) =>
        JSON.stringify(current) === JSON.stringify(result.value) ? current : result.value,
      );
    else {
      setNoticeRequestId(null);
      setNotice("Could not load requests. Try again.");
    }
  }, [environmentId, projectId, threadId, list]);
  useEffect(() => {
    const update = () => {
      if (AppState.currentState === "active") void refresh();
    };
    void Promise.resolve().then(refresh);
    const timer = setInterval(update, 30_000);
    const listener = AppState.addEventListener("change", update);
    return () => {
      clearInterval(timer);
      listener.remove();
    };
    // Source revision invalidates this read; it is not part of the RPC payload.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [refresh, revision]);
  const approve = async (id: string, targetId: string | null) => {
    const target = threads.find((thread) => thread.id === targetId);
    if (!target) return;
    setNoticeRequestId(id);
    setBusy(true);
    try {
      const prepared = await prepare({
        environmentId,
        input: {
          requestId: id,
          source: { environmentId, projectId, threadId },
          destination: { environmentId, projectId: target.projectId, threadId: target.id },
        },
      });
      if (prepared._tag === "Failure") {
        setNotice("Request changed or destination unavailable. Review it again.");
        await refresh();
        return;
      }
      const result = await confirm({ environmentId, input: { token: prepared.value.token } });
      setNotice(
        result._tag === "Success"
          ? `Queued for ${target.title}. Delivery and acceptance appear separately.`
          : "Request changed. Review it again.",
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const thread = Option.getOrNull(detail.data);
  const anchors = routeRequestAnchors(
    requests,
    messages ?? thread?.messages ?? [],
    thread?.activities ?? [],
  );
  const render = (messageId?: string) => {
    const visible = messageId
      ? requests.filter((request) => anchors.get(request.requestId) === messageId)
      : requests;
    const relevantNotice =
      notice &&
      (noticeRequestId === null
        ? !messageId ||
          messageId ===
            (messages ?? thread?.messages ?? []).find((message) => message.role === "user")?.id
        : visible.some((request) => request.requestId === noticeRequestId));
    if (!visible.length)
      return relevantNotice ? (
        <View>
          <Text accessibilityLiveRegion="polite">{notice}</Text>
          <Pressable accessibilityRole="button" onPress={() => void refresh()}>
            <Text>Refresh requests</Text>
          </Pressable>
        </View>
      ) : null;
    return (
      <View className="mx-3 mb-2 rounded-xl border border-border bg-background p-3">
        <View className="gap-3">
          <Text accessibilityRole="header" className="font-semibold">
            {visible.some((request) => request.status === "suggested")
              ? "Review handoff"
              : "Forwarded requests"}
          </Text>
          {visible.map((request) => {
            const targetId = request.destination?.threadId ?? null;
            const target = threads.find((thread) => thread.id === targetId);
            return (
              <View key={request.requestId} className="gap-2 rounded-lg border border-border p-3">
                <Text>{request.summary ?? "Forwarded request"}</Text>
                <Text className="text-xs text-muted-foreground">
                  {manualRouteStatusLabel(request.status)}
                </Text>
                {request.reason && request.reason !== "ambiguous-destination" && (
                  <Text className="text-xs text-muted-foreground">
                    {manualRouteReasonLabel(request.reason)}
                  </Text>
                )}
                {request.destination && (
                  <Pressable
                    accessibilityRole="link"
                    onPress={() =>
                      navigation.dispatch(
                        CommonActions.navigate("Thread", {
                          environmentId: request.destination!.environmentId,
                          threadId: request.destination!.threadId,
                        }),
                      )
                    }
                  >
                    <Text className="text-accent underline">
                      {target
                        ? `${projectNames.get(target.projectId) ?? "Project"} / ${target.title}`
                        : "Open destination chat"}
                    </Text>
                  </Pressable>
                )}
                {request.status === "suggested" && !request.destination && (
                  <Text>
                    No suitable working chat is available yet. Continue discussing the destination
                    here.
                  </Text>
                )}
                {request.status === "suggested" && deferred.has(request.requestId) && (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() =>
                      setDeferred((current) => {
                        const next = new Set(current);
                        next.delete(request.requestId);
                        return next;
                      })
                    }
                  >
                    <Text>Review request</Text>
                  </Pressable>
                )}
                {request.status === "suggested" && !deferred.has(request.requestId) && (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy || !target || target.archivedAt !== null}
                      onPress={() => void approve(request.requestId, targetId)}
                    >
                      <Text>Approve and send</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() =>
                        setDeferred((current) => new Set([...current, request.requestId]))
                      }
                    >
                      <Text>Not now</Text>
                    </Pressable>
                  </>
                )}
              </View>
            );
          })}
          {relevantNotice && <Text accessibilityLiveRegion="polite">{notice}</Text>}
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void refresh()}>
            <Text>Refresh status</Text>
          </Pressable>
        </View>
      </View>
    );
  };
  return children ? children(render) : render();
}
