import { useCallback, useEffect, useState } from "react";
import { AppState, Modal, Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import {
  manualRouteReasonLabel,
  manualRouteStatusLabel,
  type EnvironmentId,
  type ManualRouteStatus,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects, useThreadShells } from "../../state/entities";

export function MobileRouteRequests({
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
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<ReadonlyArray<typeof ManualRouteStatus.Type>>([]);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const source = { environmentId, projectId, threadId };
  const refresh = useCallback(async () => {
    const result = await list({
      environmentId,
      input: { source: { environmentId, projectId, threadId } },
    });
    if (result._tag === "Success") {
      setRequests(result.value);
      setNotice(result.value.length ? "" : "No routed requests in this conversation.");
    } else setNotice("Could not load requests. Try again.");
  }, [environmentId, projectId, threadId, list]);
  useEffect(() => {
    const update = () => {
      if (AppState.currentState === "active") void refresh();
    };
    update();
    const timer = setInterval(update, 30_000);
    const listener = AppState.addEventListener("change", update);
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [refresh]);
  const review = async () => {
    const target = threads.find((thread) => thread.id === destinationId);
    if (!requestId || !target) return;
    setBusy(true);
    try {
      const result = await prepare({
        environmentId,
        input: {
          requestId,
          source,
          destination: { environmentId, projectId: target.projectId, threadId: target.id },
        },
      });
      if (result._tag === "Success") {
        const confirmed = await confirm({ environmentId, input: { token: result.value.token } });
        setNotice(
          confirmed._tag === "Success"
            ? `Queued for ${target.title}. Delivery and acceptance appear separately.`
            : "Request changed. Review it again.",
        );
        if (confirmed._tag === "Success") {
          setRequestId(null);
          setDestinationId(null);
        }
        await refresh();
      } else setNotice("Request changed or destination unavailable. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="items-end px-3 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Requests: ${requests.filter((request) => request.status === "suggested").length} awaiting approval`}
        className="flex-row items-center gap-2 p-2"
        onPress={() => {
          setOpen(!open);
          if (!open) void refresh();
        }}
      >
        <SymbolView name="bell.badge" size={18} tintColorClassName="accent-icon" />
        {requests.some((request) => request.status === "suggested") && (
          <Text>{requests.filter((request) => request.status === "suggested").length}</Text>
        )}
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <ScrollView
          className="flex-1 bg-background"
          contentContainerStyle={{ padding: 24, gap: 16 }}
        >
          <Text className="text-lg font-semibold">Requests</Text>
          <Text>
            Approve where uncertain matches belong. Your original conversation stays here.
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)}>
            <Text>Done</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void refresh()}>
            <Text>Refresh requests</Text>
          </Pressable>
          {requests.map((request) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: requestId === request.requestId }}
              key={request.requestId}
              disabled={busy || request.status !== "suggested"}
              onPress={() => {
                setRequestId(request.requestId);
                setDestinationId(request.destination?.threadId ?? null);
              }}
            >
              <Text>
                {request.summary ?? "Request"} · {manualRouteStatusLabel(request.status)}
              </Text>
              {request.reason && (
                <Text className="text-xs text-muted-foreground">
                  {manualRouteReasonLabel(request.reason)}
                </Text>
              )}
              <Text className="text-xs text-muted-foreground">
                Delivered: {request.delivered ? "yes" : "no"} · Accepted:{" "}
                {request.accepted ? "yes" : "no"} · Completed: {request.completed ? "yes" : "no"}
              </Text>
            </Pressable>
          ))}
          {requestId &&
            threads.map((thread) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: destinationId === thread.id }}
                key={thread.id}
                disabled={busy}
                onPress={() => {
                  setDestinationId(thread.id);
                }}
              >
                <Text>
                  {destinationId === thread.id ? "✓ " : ""}
                  {projectNames.get(thread.projectId) ?? "Project"} / {thread.title}
                </Text>
              </Pressable>
            ))}
          {requestId && destinationId && (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void review()}>
              <Text>Approve and send</Text>
            </Pressable>
          )}
          {!!notice && <Text accessibilityLiveRegion="polite">{notice}</Text>}
        </ScrollView>
      </Modal>
    </View>
  );
}
