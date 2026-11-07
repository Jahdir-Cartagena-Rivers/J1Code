import { useEffect, useState, useSyncExternalStore } from "react";
import * as Schema from "effect/Schema";

const Row = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["bot", "room", "message"]),
  title: Schema.String,
  description: Schema.String,
});
export type MausbotSearchRow = typeof Row.Type;
const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row));
type Provider = {
  search: (query: string, signal: AbortSignal) => Promise<unknown>;
  land: (key: string) => Promise<void>;
};
let provider: Provider | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => provider;

/** One active environment owns the bridge; disconnecting immediately invalidates its results and actions. */
export function registerMausbotSearch(value: Provider) {
  provider = value;
  for (const listener of listeners) listener();
  return () => {
    if (provider === value) {
      provider = null;
      for (const listener of listeners) listener();
    }
  };
}

export function useMausbotSearch(query: string, enabled: boolean) {
  const connection = useSyncExternalStore(subscribe, snapshot, () => null);
  const [result, setResult] = useState<{
    connection: Provider;
    query: string;
    attempt: number;
    rows: readonly MausbotSearchRow[];
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !connection) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        void connection
          .search(query.slice(0, 1000), controller.signal)
          .then((value) => {
            const rows = decodeRows(value);
            if (
              rows.length > 40 ||
              rows.some(
                (row) =>
                  row.key.length > 200 || row.title.length > 200 || row.description.length > 400,
              )
            )
              throw new Error("Invalid bot search results.");
            if (!controller.signal.aborted) setResult({ connection, query, attempt, rows });
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setResult({
                connection,
                query,
                attempt,
                rows: [],
                error: "Bot search unavailable. Try again.",
              });
          });
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [connection, query, enabled, attempt]);
  const current =
    enabled &&
    connection &&
    result?.connection === connection &&
    result.query === query &&
    result.attempt === attempt
      ? result
      : null;
  return {
    connected: enabled && connection !== null,
    pending: enabled && connection !== null && !current,
    rows: current?.rows ?? [],
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
    land: async (key: string) => {
      if (!connection || provider !== connection)
        throw new Error("The bot environment changed. Search again.");
      await connection.land(key);
    },
  };
}
