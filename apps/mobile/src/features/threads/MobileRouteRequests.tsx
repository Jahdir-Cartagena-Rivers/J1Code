import { useState } from "react";
import { Pressable, View } from "react-native";
import type { EnvironmentId, ManualRouteStatus } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadShells } from "../../state/entities";

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
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const source = { environmentId, projectId, threadId };
  const refresh = async () => {
    setBusy(true);
    try {
      const result = await list({ environmentId, input: { source } });
      if (result._tag === "Success") {
        setRequests(result.value);
        setNotice(result.value.length ? "" : "No routed requests in this conversation.");
      } else setNotice("Could not load requests. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const review = async () => {
    const target = threads.find((thread) => thread.id === destinationId);
    if (!requestId || !target) return;
    setBusy(true);
    setToken(null);
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
        setToken(result.value.token);
        setNotice("Destination checked. Confirm to queue this request.");
      } else setNotice("Request changed or destination unavailable. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="px-3 py-1">
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setOpen(!open);
          if (!open) void refresh();
        }}
      >
        <Text className="text-xs text-muted-foreground">Request routing</Text>
      </Pressable>
      {open && (
        <View className="gap-2 py-2">
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void refresh()}>
            <Text>Refresh requests</Text>
          </Pressable>
          {requests.map((request) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: requestId === request.requestId }}
              key={request.requestId}
              disabled={busy}
              onPress={() => {
                setRequestId(request.requestId);
                setDestinationId(request.destination?.threadId ?? null);
                setToken(null);
              }}
            >
              <Text>
                {request.summary ?? "Request"} · {request.status}
              </Text>
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
                  setToken(null);
                }}
              >
                <Text>
                  {destinationId === thread.id ? "✓ " : ""}
                  {thread.title}
                </Text>
              </Pressable>
            ))}
          {requestId && destinationId && (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void review()}>
              <Text>Review destination</Text>
            </Pressable>
          )}
          {token && (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={async () => {
                const saved = token;
                setToken(null);
                setBusy(true);
                try {
                  const result = await confirm({ environmentId, input: { token: saved } });
                  setNotice(
                    result._tag === "Success"
                      ? "Queued. Refresh to check delivery and acceptance."
                      : "Confirmation expired or request changed. Review again.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Text>Confirm routing</Text>
            </Pressable>
          )}
          {!!notice && <Text accessibilityLiveRegion="polite">{notice}</Text>}
        </View>
      )}
    </View>
  );
}
