import { useEffect, useRef, useState } from "react";
import { api } from "@/state/api";

export function J1ResumeButton({ botId, threadId }: { botId: string; threadId: string }) {
  const [revision, setRevision] = useState<string | null>(null);
  const [error, setError] = useState("");
  const submitted = useRef(false);
  const path = "/api/bots/" + encodeURIComponent(botId) + "/resume";

  useEffect(() => {
    const controller = new AbortController();
    void api<{ revision: string | null }>(path + "?threadId=" + encodeURIComponent(threadId), {
      background: true,
      signal: controller.signal,
    }).then(({ revision: current }) => {
      if (!controller.signal.aborted) setRevision(current);
    }).catch(() => { /* No saved Resume action is available. */ });
    return () => controller.abort();
  }, [path, threadId]);

  if (error) return <span role="status" className="text-xs text-danger">{error}</span>;
  if (!revision) return null;
  return (
    <button
      type="button"
      className="rounded-md px-2 py-1 text-sm text-ink-secondary hover:bg-raised hover:text-ink"
      onClick={() => {
        if (submitted.current) return;
        submitted.current = true;
        setRevision(null);
        void api(path, { method: "POST", body: JSON.stringify({ threadId, revision }) }).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "Resume could not be confirmed. Check the thread before trying again.");
        });
      }}
    >
      Resume
    </button>
  );
}
