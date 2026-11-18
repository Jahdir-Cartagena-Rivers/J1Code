// Private IPC to the captured J1 parent. This module has no runtime/config imports.
import * as NodeCrypto from "node:crypto";
export type SharedObject = Record<string, unknown>;
export const sharedObject = (value: unknown): value is SharedObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const listeners = new Set<(event: SharedObject) => void>();
export const onSharedExecution = (listener: (event: SharedObject) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function sharedExecutionRequest(input: unknown): Promise<unknown> {
  if (!process.send || !process.connected)
    return Promise.reject(new Error("Open this shared provider in J1."));
  if (pending.size >= 128)
    return Promise.reject(new Error("Too many shared execution requests are open."));
  const requestId = NodeCrypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    process.send!({ type: "j1:execution-request", requestId, input }, (error: Error | null) => {
      if (!error) return;
      pending.delete(requestId);
      reject(new Error("J1's shared execution connection closed."));
    });
  });
}
process.on("message", (message: unknown) => {
  if (!sharedObject(message)) return;
  if (message.type === "j1:execution-event" && sharedObject(message.event)) {
    for (const listener of listeners) listener(message.event);
  } else if (message.type === "j1:execution-result" && typeof message.requestId === "string") {
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (typeof message.error === "string") request.reject(new Error(message.error));
    else request.resolve(message.value);
  }
});
process.once("disconnect", () => {
  for (const request of pending.values())
    request.reject(new Error("J1's shared execution connection closed."));
  pending.clear();
  for (const listener of listeners) listener({ kind: "disconnected" });
});
export type SharedCatalogRow = {
  instanceId: string;
  displayName?: string;
  driver: string;
  nativeDefault?: string;
  enabled: boolean;
  installed: boolean;
  auth: { status: string };
  models: Array<{
    slug: string;
    name: string;
    isDefault?: boolean;
    capabilities?: {
      optionDescriptors?: Array<{
        id: string;
        type: string;
        options?: Array<{ id: string; label: string }>;
      }>;
    } | null;
  }>;
};
export async function sharedCatalog(): Promise<SharedCatalogRow[]> {
  const value = await sharedExecutionRequest({ action: "catalog" });
  if (!Array.isArray(value)) throw new Error("J1's provider catalog is unavailable.");
  return value.filter(
    (row): row is SharedCatalogRow =>
      sharedObject(row) && typeof row.instanceId === "string" && Array.isArray(row.models),
  );
}
