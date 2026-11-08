import { useEffect, useState } from "react";
import { z } from "zod";
import { j1Request } from "../j1-native-client";
import { AskCard, ASK_SECONDARY_BUTTON, askPrimary } from "./AskCard";

const receipt = z.object({
  requestId: z.string(),
  revision: z.number().int().nonnegative(),
  summary: z.string().optional(),
  status: z.string(),
  label: z.string(),
  reasonText: z.string().nullable(),
  destinationLabel: z.string(),
  destinationUrl: z.string().nullable(),
});
const lists = new Map<string, Promise<z.infer<typeof receipt>[]>>();
/** One source read for cards mounted together; the native host retains its request bound. */
export function readReceipt(
  botId: string,
  threadId: string,
  requestId: string,
  revision = 0,
  retry = true,
): Promise<z.infer<typeof receipt>> {
  const key = `${botId}:${threadId}`;
  let pending = lists.get(key);
  if (!pending) {
    pending = j1Request("routingList", { botId, threadId }).then((value) =>
      z.array(receipt).parse(value),
    );
    lists.set(key, pending);
    void pending
      .finally(() => {
        if (lists.get(key) === pending) lists.delete(key);
      })
      .catch(() => {});
  }
  return pending.then((rows) => {
    const row = rows.find((row) => row.requestId === requestId);
    if (!row) throw new Error("The routing request changed.");
    // A source notice can overtake the one shared read already in flight.
    if (row.revision < revision && retry)
      return readReceipt(botId, threadId, requestId, revision, false);
    return row;
  });
}
export function J1RouteCard({
  botId,
  threadId,
  requestId,
  revision,
  text,
}: {
  botId: string;
  threadId: string;
  requestId: string;
  revision?: number;
  text?: string;
}) {
  const version = `${botId}:${threadId}:${requestId}:${revision ?? 0}`;
  const [loaded, setLoaded] = useState<{ version: string; value: z.infer<typeof receipt> } | null>(
    null,
  );
  const view = loaded?.version === version ? loaded.value : null;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deferred, setDeferred] = useState(false);
  useEffect(() => {
    let live = true;
    void readReceipt(botId, threadId, requestId, revision)
      .then((value) => {
        const result = receipt.parse(value);
        if (result.requestId !== requestId) throw new Error("The routing request changed.");
        if (live) {
          setLoaded({ version, value: result });
          setError("");
        }
      })
      .catch(() => {
        if (live) setError("Reconnect to view this routing request.");
      });
    return () => {
      live = false;
    };
  }, [botId, threadId, requestId, revision, version]);
  const approve = async () => {
    setBusy(true);
    try {
      const value = receipt.parse(
        await j1Request("routingApprove", { botId, threadId, requestId }),
      );
      if (value.requestId !== requestId) throw new Error("The routing request changed.");
      // A source notice can load a newer revision before this approval returns.
      setLoaded((current) => (current?.version === version ? { version, value } : current));
      setError("");
    } catch {
      setError("Could not approve this request. Review it again.");
    } finally {
      setBusy(false);
    }
  };
  const primary = askPrimary(undefined);
  return (
    <AskCard
      title={view?.label ?? "Routing request"}
      ariaLabel="Routing request"
      explanation={view?.summary ?? text}
      footer={
        <>
          {view?.destinationUrl && (
            <button
              type="button"
              className={ASK_SECONDARY_BUTTON}
              onClick={() => {
                void j1Request("routingOpen", { botId, threadId, requestId }).catch(() =>
                  setError("Conversation unavailable."),
                );
              }}
            >
              {view.destinationLabel}
            </button>
          )}
          {view?.status === "suggested" && view.destinationUrl && !deferred && (
            <>
              <button
                type="button"
                disabled={busy}
                className={primary.className}
                style={primary.style}
                onClick={approve}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                className={ASK_SECONDARY_BUTTON}
                onClick={() => setDeferred(true)}
              >
                Not now
              </button>
            </>
          )}
          {view?.status === "suggested" && deferred && (
            <button
              type="button"
              className={ASK_SECONDARY_BUTTON}
              onClick={() => setDeferred(false)}
            >
              Review request
            </button>
          )}
        </>
      }
    >
      {view?.reasonText && <p className="text-[13px] text-ink-secondary">{view.reasonText}</p>}
      {error && (
        <p role="status" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </AskCard>
  );
}
