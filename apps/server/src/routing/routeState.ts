import * as NodeCrypto from "node:crypto";

export interface RouteEndpoint {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
}

export interface RouteRequest {
  readonly requestId: string;
  readonly taskId?: string;
  readonly sourceUrl?: string;
  readonly source: RouteEndpoint;
  readonly destination: RouteEndpoint | null;
  readonly content: string;
  /** Verified capabilities, not provider permission-mode labels or model assertions. */
  readonly permissionCeiling: readonly string[];
  readonly destinationPermissions: readonly string[];
  readonly visited: readonly RouteEndpoint[];
  readonly maxHops: number;
  readonly ambiguous: boolean;
  readonly mode: "off" | "suggest" | "auto";
  readonly initiation: "automatic" | "manual";
}

export type RouteStatus =
  | "blocked"
  | "suggested"
  | "queued"
  | "sending"
  | "admitted"
  | "delivered"
  | "accepted"
  | "completed"
  | "failed"
  | "uncertain";

export interface RouteState {
  readonly request: RouteRequest;
  readonly originalRequest: RouteRequest;
  readonly resolution: RouteResolution | null;
  readonly fingerprint: string;
  readonly status: RouteStatus;
  readonly reason: string | null;
  readonly attemptId: string | null;
  readonly receipts: readonly RouteReceipt[];
}

export interface RouteReceipt {
  readonly receiptId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly attemptId: string;
  readonly destination: RouteEndpoint;
  readonly kind: "delivered" | "accepted" | "completed" | "failed";
}

export type RouteEvent =
  | { readonly type: "confirm" }
  | { readonly type: "begin-send"; readonly attemptId: string }
  | { readonly type: "send-interrupted" }
  | { readonly type: "admitted" }
  | { readonly type: "admission-rejected" }
  | { readonly type: "receipt"; readonly receipt: RouteReceipt };

function endpointKey(endpoint: RouteEndpoint) {
  return JSON.stringify([endpoint.environmentId, endpoint.projectId, endpoint.threadId]);
}

export interface RouteResolution {
  readonly userId: string;
  readonly source: RouteEndpoint;
  readonly destination: RouteEndpoint;
  readonly destinationPermissions: readonly string[];
}

/** Trusted server facts, never decoded from model/tool arguments. */
export interface RouteResolutionAuthority extends RouteResolution {
  readonly authenticatedUser: true;
}

export function resolveRoute(state: RouteState, authority: RouteResolutionAuthority): RouteState {
  if (
    !authority?.authenticatedUser ||
    !authority.userId.trim() ||
    endpointKey(authority.source) !== endpointKey(state.originalRequest.source)
  )
    throw new Error("Unauthorized route resolution");
  if (state.status !== "suggested") throw new Error("Invalid route resolution");
  const request = structuredClone({
    ...state.request,
    destination: authority.destination,
    destinationPermissions: authority.destinationPermissions,
    ambiguous: false,
  });
  const reason = blockedReason(request);
  if (reason) throw new Error(reason);
  return {
    ...state,
    request,
    resolution: structuredClone(authority),
    status: "queued",
    reason: null,
  };
}

/** Binds original intent; discovery and user selection cannot change identity.
 * requestId is the independent durable uniqueness key. */
export function routeFingerprint(request: RouteRequest): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        endpointKey(request.source),
        request.content,
        request.taskId ?? null,
        request.sourceUrl ?? null,
        [...new Set(request.permissionCeiling)].sort(),
        request.visited.map(endpointKey),
        request.maxHops,
        request.mode,
        request.initiation,
      ]),
    )
    .digest("hex");
}

function blockedReason(request: RouteRequest): string | null {
  if (!request.requestId.trim()) return "missing-request-id";
  if (!request.destination && !request.ambiguous) return "missing-destination";
  if (
    !Number.isInteger(request.maxHops) ||
    request.maxHops < 1 ||
    request.visited.length >= request.maxHops
  )
    return "hop-limit";
  const path = [...request.visited, request.source].map(endpointKey);
  if (
    new Set(path).size !== path.length ||
    (request.destination && path.includes(endpointKey(request.destination)))
  )
    return "routing-loop";
  if (
    request.destinationPermissions.some(
      (permission) => !request.permissionCeiling.includes(permission),
    )
  )
    return "permission-escalation";
  if (request.mode === "off" && request.initiation === "automatic") return "routing-off";
  return null;
}

/** Caller must atomically persist uniqueness by requestId before any reactor sends. */
export function registerRoute(request: RouteRequest, existing?: RouteState): RouteState {
  const fingerprint = routeFingerprint(request);
  if (existing) {
    if (existing.request.requestId !== request.requestId || existing.fingerprint !== fingerprint)
      throw new Error("Route identity conflict");
    return existing;
  }
  const snapshot = structuredClone(request);
  const reason = blockedReason(snapshot);
  return {
    request: snapshot,
    originalRequest: structuredClone(snapshot),
    resolution: null,
    fingerprint,
    reason: reason ?? (snapshot.ambiguous ? "ambiguous-destination" : null),
    attemptId: null,
    receipts: [],
    status: reason
      ? "blocked"
      : snapshot.ambiguous || (snapshot.mode === "suggest" && snapshot.initiation === "automatic")
        ? "suggested"
        : "queued",
  };
}

/** Pure infrastructure only: events must come from authenticated server receipts, never model prose.
 * Integration still requires contract schemas, atomic event-store/outbox persistence and replay,
 * a reactor persisting begin-send BEFORE provider dispatch, crash reconciliation, destination
 * permission revalidation at dispatch, provider acceptance/completion receipts, and UI mode,
 * destination confirmation, ambiguity and separate delivery/execution status presentation.
 * Legacy confirm events fail closed; user confirmation must use resolveRoute with trusted facts.
 */
export function transitionRoute(state: RouteState, event: RouteEvent): RouteState {
  if (event.type === "admission-rejected" && state.status === "sending")
    return { ...state, status: "queued", attemptId: null, reason: "admission-held" };
  if (event.type === "admitted" && state.status === "sending")
    return {
      ...state,
      status: "admitted",
      reason: "turn-start-persisted-provider-outcome-untracked",
    };

  if (event.type === "begin-send" && state.status === "queued" && event.attemptId.trim())
    return { ...state, status: "sending", attemptId: event.attemptId };
  if (
    event.type === "send-interrupted" &&
    (state.status === "sending" || state.status === "admitted")
  )
    return { ...state, status: "uncertain", reason: "send-outcome-unknown" };
  if (event.type !== "receipt") throw new Error("Invalid route transition");
  const receipt = event.receipt;
  if (
    !receipt.receiptId.trim() ||
    receipt.requestId !== state.request.requestId ||
    receipt.fingerprint !== state.fingerprint ||
    receipt.attemptId !== state.attemptId ||
    !state.request.destination ||
    endpointKey(receipt.destination) !== endpointKey(state.request.destination)
  )
    throw new Error("Receipt identity mismatch");
  const previous = state.receipts.find((entry) => entry.receiptId === receipt.receiptId);
  if (previous) {
    if (previous.kind !== receipt.kind) throw new Error("Receipt identity conflict");
    return state;
  }
  const allowed: Record<RouteReceipt["kind"], readonly RouteStatus[]> = {
    delivered: ["sending", "admitted", "uncertain"],
    accepted: ["delivered"],
    completed: ["accepted"],
    failed: ["sending", "admitted", "uncertain", "delivered", "accepted"],
  };
  if (!allowed[receipt.kind].includes(state.status)) throw new Error("Invalid receipt transition");
  return {
    ...state,
    status: receipt.kind,
    reason: receipt.kind === "failed" ? "receipt-failed" : null,
    receipts: [...state.receipts, structuredClone(receipt)],
  };
}
