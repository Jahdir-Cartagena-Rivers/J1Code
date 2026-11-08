import {
  manualRouteReasonLabel,
  manualRouteStatusLabel,
  type ManualRouteEndpoint,
  type ManualRouteStatus,
  type ManualRoutePrepareInput,
} from "@t3tools/contracts";
import { routeEndpointUrl } from "@t3tools/shared/routeEndpointUrl";

export const isMausbotRoutingMethod = (method: string) =>
  ["routingList", "routingStatus", "routingApprove", "routingOpen"].includes(method);
export interface MausbotRoutingHost {
  environmentId: string;
  list(
    source: typeof ManualRouteEndpoint.Type,
  ): Promise<ReadonlyArray<typeof ManualRouteStatus.Type>>;
  prepare(input: typeof ManualRoutePrepareInput.Type): Promise<{ token: string }>;
  confirm(token: string): Promise<void>;
  open(endpoint: typeof ManualRouteEndpoint.Type): Promise<void>;
  label(endpoint: typeof ManualRouteEndpoint.Type): string;
}
/** Human client actions use the original session-authenticated routing boundary on every surface. */
export async function callMausbotRouting(method: string, raw: unknown, host: MausbotRoutingHost) {
  if (!isMausbotRoutingMethod(method) || !raw || typeof raw !== "object")
    throw new Error("Routing request unavailable.");
  const input = raw as Record<string, unknown>;
  if (
    !Object.keys(input).every((key) => ["botId", "threadId", "requestId"].includes(key)) ||
    ![input.botId, input.threadId].every(
      (value) => typeof value === "string" && /^[\w-]{1,120}$/.test(value),
    ) ||
    (method !== "routingList" &&
      (typeof input.requestId !== "string" || input.requestId.length > 200))
  )
    throw new Error("Routing request unavailable.");
  const source = {
    environmentId: host.environmentId,
    projectId: `mausbot:${input.botId}`,
    threadId: `mausbot:${input.botId}:${input.threadId}`,
  };
  const present = (row: typeof ManualRouteStatus.Type) => ({
    ...row,
    label: manualRouteStatusLabel(row.status),
    reasonText: row.reason === "ambiguous-destination" ? null : manualRouteReasonLabel(row.reason),
    destinationLabel: row.destination
      ? host.label(row.destination)
      : "Open destination conversation",
    destinationUrl: row.destination ? routeEndpointUrl(row.destination) : null,
  });
  if (method === "routingList") return (await host.list(source)).map(present);
  const load = async () => {
    const row = (await host.list(source)).find((item) => item.requestId === input.requestId);
    if (!row) throw new Error("Routing request unavailable.");
    return row;
  };
  let row = await load();
  if (method === "routingApprove") {
    if (row.status !== "suggested" || !row.destination)
      throw new Error("Review the changed request.");
    const prepared = await host.prepare({
      source,
      requestId: row.requestId,
      destination: row.destination,
    });
    await host.confirm(prepared.token);
    row = await load();
  }
  if (method === "routingOpen") {
    if (!row.destination) throw new Error("Conversation unavailable.");
    await host.open(row.destination);
    return true;
  }
  return present(row);
}
