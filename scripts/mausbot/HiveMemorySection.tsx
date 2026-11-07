import { useEffect, useState } from "react";
type Status = {
  enabled: boolean;
  available?: boolean;
  message?: string;
  lastError?: string;
  indexed?: number;
};

/** Appears inside the original Memory panel; local editing, upkeep and history retain their upstream handlers. */
export function HiveMemorySection({
  botId,
  active,
  busy: botBusy,
  memoryEnabled,
}: {
  botId: string;
  active: boolean;
  busy: boolean;
  memoryEnabled: boolean;
}) {
  const [state, setState] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const route = `/api/bots/${encodeURIComponent(botId)}/memory/hive`;
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    setState(null);
    setError("");
    fetch(route)
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "Could not check Hive Mind.");
        if (mounted) setState(value);
      })
      .catch(() => {
        if (mounted) setError("Could not check Hive Mind. Local notes remain available.");
      });
    return () => {
      mounted = false;
    };
  }, [route, active]);
  const check = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(route);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not check Hive Mind.");
      setState(value);
    } catch {
      setError("Could not check Hive Mind. Local notes remain available.");
    } finally {
      setBusy(false);
    }
  };
  const change = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not change extended recall.");
      setState(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not change extended recall.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-xl bg-card p-4">
      <h3 className="text-[15px] font-medium text-ink">Hive Mind extended memory</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
        Keep local notes and retrieve relevant passages through J1’s selected external Hive Mind,
        including notes beyond the always-loaded MEMORY.md limit. Model context limits still apply.
      </p>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
        Enabling copies this assistant’s MEMORY.md and topic notes to Hive Mind. Logs are excluded.
        Each assistant has its own scope. Future note changes sync before recall; local files remain
        authoritative.
      </p>
      <p role="status" className="mt-2 text-[13px] text-ink-secondary">
        {busy
          ? "Updating extended memory…"
          : (state?.message ?? "Checking the Hive Mind connection…")}
        {state?.indexed !== undefined ? ` ${state.indexed} passages indexed.` : ""}
      </p>
      {(error || state?.lastError) && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error || state?.lastError}
        </p>
      )}
      <button
        type="button"
        className="mt-3 rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        disabled={
          busy || botBusy || !state || (!state.enabled && (!state.available || !memoryEnabled))
        }
        onClick={() => void change(!state?.enabled)}
      >
        {state?.enabled ? "Turn off extended recall" : "Enable and copy notes to Hive Mind"}
      </button>
      <button
        type="button"
        className="ml-2 mt-3 rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        disabled={busy}
        onClick={() => void check()}
      >
        Check connection
      </button>
      <p className="mt-2 text-[12px] text-ink-secondary">
        Configure the connection in J1 Settings → Hive Mind. Turning this off preserves both local
        notes and existing Hive Mind copies.
      </p>
    </section>
  );
}
