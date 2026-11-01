import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useThreadShells } from "../../state/entities";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** Confirmation is a client action; agents cannot redeem the connection-bound token. */
export function RouteRequestControl({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  threadId: string;
}) {
  const prepare = useAtomCommand(serverEnvironment.routingPrepare, { reportFailure: false });
  const confirm = useAtomCommand(serverEnvironment.routingConfirm, { reportFailure: false });
  const status = useAtomCommand(serverEnvironment.routingStatus, { reportFailure: false });
  const list = useAtomCommand(serverEnvironment.routingList, { reportFailure: false });
  const [requests, setRequests] = useState<
    ReadonlyArray<{ requestId: string; summary?: string; status: string }>
  >([]);
  const [requestId, setRequestId] = useState("");
  const [destination, setDestination] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      thread.id !== threadId,
  );
  const source = { environmentId, projectId, threadId };
  const refresh = async () => {
    const result = await list({ environmentId, input: { source } });
    if (result._tag === "Failure") {
      setNotice("Could not load routing requests. Try again.");
      return;
    }
    setRequests(result.value);
    if (!result.value.length) setNotice("No routed requests in this conversation.");
  };
  const inspect = async () => {
    setBusy(true);
    try {
      const result = await status({ environmentId, input: { requestId, source } });
      if (result._tag === "Failure") {
        setNotice("Request unavailable in this conversation.");
        return;
      }
      setNotice(
        `${result.value.status}${result.value.reason ? `: ${result.value.reason}` : ""}. Sent, accepted and completed are separate states.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const select = async () => {
    setBusy(true);
    setToken(null);
    try {
      const target = threads.find((thread) => thread.id === destination);
      if (!target) {
        setNotice("Destination is no longer available.");
        return;
      }
      const result = await prepare({
        environmentId,
        input: {
          requestId,
          source,
          destination: { environmentId, projectId: target.projectId, threadId: target.id },
        },
      });
      if (result._tag === "Failure") {
        setNotice("Destination unavailable or request changed. Check its status.");
        return;
      }
      setToken(result.value.token);
      setNotice("Destination checked. Confirm to queue this request there.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="px-3 py-1 text-xs">
      <summary>Request routing</summary>
      <div className="space-y-2 py-2">
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          Refresh requests
        </Button>
        <Select
          items={requests.map((request) => ({
            value: request.requestId,
            label: request.summary ?? request.status,
          }))}
          value={requestId || null}
          onValueChange={(value) => {
            setRequestId(value ?? "");
            setToken(null);
          }}
        >
          <SelectTrigger aria-label="Routing request">
            <SelectValue placeholder="Choose a request" />
          </SelectTrigger>
          <SelectPopup>
            {requests.map((request) => (
              <SelectItem key={request.requestId} value={request.requestId}>
                {request.summary ?? "Request"} · {request.status}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          items={threads.map((thread) => ({ value: thread.id, label: thread.title }))}
          value={destination || null}
          onValueChange={(value) => {
            setDestination(value ?? "");
            setToken(null);
          }}
        >
          <SelectTrigger aria-label="Destination conversation">
            <SelectValue placeholder="Choose a conversation" />
          </SelectTrigger>
          <SelectPopup>
            {threads.map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {thread.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !requestId}
            onClick={() => void inspect()}
          >
            Check status
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !requestId || !destination}
            onClick={() => void select()}
          >
            Review destination
          </Button>
          {token && (
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const saved = token;
                setToken(null);
                try {
                  const r = await confirm({ environmentId, input: { token: saved } });
                  setNotice(
                    r._tag === "Success"
                      ? "Queued. Check status for delivery and acceptance."
                      : "Confirmation expired or request changed. Review it again.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Confirm routing
            </Button>
          )}
        </div>
        {notice && <p role="status">{notice}</p>}
      </div>
    </details>
  );
}
