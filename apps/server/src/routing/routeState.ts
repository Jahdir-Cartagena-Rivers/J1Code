import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@j1code/shared/relaySigning";
import type { OrchestrationV2IdleRouteCommand } from "@j1code/contracts";
import type { PreparedStrictRouteDelivery, StrictRouteDeliveryResult } from "./v2StrictDelivery.ts";

export interface RouteEndpoint {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
}

export interface RouteOrigin {
  readonly subject: string;
  readonly runId: string;
  readonly messageId: string;
}

export interface RouteRequest {
  readonly origin?: RouteOrigin;
  readonly requestId: string;
  /** Server-owned return channel; feedback never generates another status notification. */
  readonly feedbackFor?: string;
  readonly feedbackMessageHash?: string;
  readonly monitorSource?: boolean;
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

export interface StrictRouteSubmission {
  readonly routeFingerprint: string;
  readonly descriptorFingerprint: string;
  readonly delivery: PreparedStrictRouteDelivery;
}

export interface IdleRouteSubmission {
  readonly routeFingerprint: string;
  readonly commandFingerprint: string;
  readonly command: OrchestrationV2IdleRouteCommand;
}

export type IdleDeliveryEvidence = "admitted" | "delivered" | "failed" | "uncertain";

export interface RouteState {
  readonly inputFingerprint?: string;
  readonly request: RouteRequest;
  readonly originalRequest: RouteRequest;
  readonly resolution: RouteResolution | null;
  readonly fingerprint: string;
  readonly status: RouteStatus;
  readonly reason: string | null;
  readonly attemptId: string | null;
  readonly receipts: readonly RouteReceipt[];
  readonly strictSubmission?: StrictRouteSubmission;
  readonly idleSubmission?: IdleRouteSubmission;
}

export function bindRouteInputFingerprint(state: RouteState, inputFingerprint: string): RouteState {
  if (!/^[a-f0-9]{64}$/u.test(inputFingerprint)) throw new Error("Invalid original route input fingerprint");
  if (state.inputFingerprint !== undefined && state.inputFingerprint !== inputFingerprint)
    throw new Error("Route input identity conflict");
  return { ...state, inputFingerprint };
}

export function replayRouteInput(state: RouteState, inputFingerprint: string): RouteState {
  if (state.inputFingerprint === undefined)
    throw new Error("This saved route has no original input proof; read its existing status instead of resubmitting it.");
  if (state.inputFingerprint !== inputFingerprint) throw new Error("Route input identity conflict");
  return state;
}

export interface RouteReceipt {
  readonly receiptId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly attemptId: string;
  readonly destination: RouteEndpoint;
  readonly kind: "delivered" | "accepted" | "completed" | "failed";
  readonly message?: string;
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
    (state.originalRequest.origin !== undefined &&
      authority.userId !== state.originalRequest.origin.subject) ||
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

/** Server-only rediscovery under the original Auto authorization. It cannot
 * approve Suggest requests or manufacture a user confirmation. The caller must
 * verify a unique current owner and refresh endpoint permissions before CAS.
 */
export function resolveDiscoveredOwner(
  state: RouteState,
  destination: RouteEndpoint,
  destinationPermissions: readonly string[],
): RouteState {
  if (
    state.status !== "suggested" ||
    state.originalRequest.mode !== "auto" ||
    state.request.mode !== "auto" ||
    state.originalRequest.initiation !== "automatic" ||
    state.resolution !== null
  )
    throw new Error("Automatic rediscovery is not authorized");
  const request = structuredClone({
    ...state.request,
    destination,
    destinationPermissions,
    ambiguous: false,
  });
  const reason = blockedReason(request);
  if (reason) throw new Error(reason);
  return { ...state, request, status: "queued", reason: null };
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
        ...(request.origin === undefined ? [] : [request.origin.subject, request.origin.runId, request.origin.messageId]),
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
  if ((state.strictSubmission !== undefined || state.idleSubmission !== undefined) && (
    event.type === "admission-rejected" ||
    event.type === "admitted" ||
    (event.type === "receipt" && (
      event.receipt.kind === "delivered" ||
      (event.receipt.kind === "failed" &&
        ["sending", "admitted", "uncertain"].includes(state.status))
    ))
  )) throw new Error("Native route submission requires correlated delivery evidence");
  return applyRouteTransition(state, event);
}

function applyRouteTransition(state: RouteState, event: RouteEvent): RouteState {
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
    if (previous.kind !== receipt.kind || previous.message !== receipt.message)
      throw new Error("Receipt identity conflict");
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
    // A fresh authenticated receipt also opts an older in-flight request into monitoring.
    request: state.request.feedbackFor ? state.request : { ...state.request, monitorSource: true },
    status: receipt.kind,
    reason: receipt.kind === "failed" ? "receipt-failed" : null,
    receipts: [...state.receipts, structuredClone(receipt)],
  };
}

export function strictRouteDescriptorFingerprint(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function idleRouteIdentity(requestId: string, attemptId: string) {
  const key = strictRouteDescriptorFingerprint([requestId, attemptId]);
  return {
    commandId: `command:route-idle:${key}`,
    messageId: `message:route-idle:${key}`,
    runId: `run:route-idle:${key}`,
  };
}

export function assertIdleRouteSubmission(state: RouteState): void {
  const claim = state.idleSubmission;
  if (claim === undefined) return;
  const { command, routeFingerprint, commandFingerprint } = claim;
  const { request } = state;
  const identity = idleRouteIdentity(command.requestId, command.attemptId);
  if (state.strictSubmission !== undefined ||
      !["sending", "admitted", "uncertain", "delivered", "accepted", "completed", "failed"].includes(state.status) ||
      state.fingerprint !== routeFingerprint || state.attemptId !== command.attemptId ||
      commandFingerprint !== strictRouteDescriptorFingerprint(command) ||
      command.requestId !== request.requestId || command.text !== request.content ||
      command.commandId !== identity.commandId || command.messageId !== identity.messageId ||
      command.runId !== identity.runId ||
      request.source.environmentId !== command.environmentId ||
      request.source.threadId !== command.senderThreadId || request.source.projectId !== command.sourceProjectId ||
      request.destination?.environmentId !== command.environmentId ||
      request.destination.threadId !== command.threadId || request.destination.projectId !== command.projectId ||
      !request.permissionCeiling.includes(`runtime:${command.runtimeMode}`) ||
      !request.destinationPermissions.includes(`runtime:${command.runtimeMode}`)) {
    throw new Error("Idle route claim identity mismatch");
  }
}

export function claimIdleRouteSubmission(
  state: RouteState,
  routeFingerprint: string,
  command: OrchestrationV2IdleRouteCommand,
): RouteState {
  if (state.status !== "sending" || state.strictSubmission !== undefined || state.idleSubmission !== undefined)
    throw new Error("Idle route claim already exists or is unavailable");
  const next = {
    ...state, idleSubmission: {
      routeFingerprint, commandFingerprint: strictRouteDescriptorFingerprint(command),
      command: structuredClone(command),
    },
  };
  assertIdleRouteSubmission(next);
  return next;
}

export function settleIdleRouteSubmission(
  state: RouteState,
  commandFingerprint: string,
  evidence: IdleDeliveryEvidence,
): RouteState {
  assertIdleRouteSubmission(state);
  const claim = state.idleSubmission;
  if (claim === undefined || claim.commandFingerprint !== commandFingerprint)
    throw new Error("Idle route result identity mismatch");
  if (!["sending", "admitted", "uncertain"].includes(state.status)) return state;
  switch (evidence) {
    case "admitted":
      return state.status === "admitted" ? state : {
        ...state, status: "admitted", reason: "idle-route-awaiting-native-start",
      };
    case "uncertain":
      return state.status === "uncertain" ? state : applyRouteTransition(state, { type: "send-interrupted" });
    case "delivered":
    case "failed": {
      const destination = state.request.destination;
      if (!destination) throw new Error("Idle route destination missing");
      return applyRouteTransition(state, {
        type: "receipt",
        receipt: {
          receiptId: `idle:${claim.command.commandId}:${evidence}`,
          requestId: state.request.requestId,
          fingerprint: state.fingerprint,
          attemptId: claim.command.attemptId,
          destination,
          kind: evidence,
        },
      });
    }
  }
}

export function assertStrictRouteSubmission(state: RouteState): void {
  const claim = state.strictSubmission;
  if (claim === undefined) return;
  const { delivery, routeFingerprint: fingerprint, descriptorFingerprint } = claim;
  const { attempt, command } = delivery;
  const { source, destination } = state.request;
  const { target } = command;
  const identity = strictRouteDescriptorFingerprint([attempt.requestId, attempt.attemptId]);
  const expectedSender = source.environmentId === destination?.environmentId
    ? source.threadId : undefined;
  if (
    !["sending", "admitted", "uncertain", "delivered", "accepted", "completed", "failed"].includes(state.status) ||
    !state.attemptId ||
    !destination ||
    fingerprint !== state.fingerprint ||
    routeFingerprint(state.originalRequest) !== fingerprint ||
    descriptorFingerprint !== strictRouteDescriptorFingerprint(delivery) ||
    attempt.requestId !== state.request.requestId ||
    attempt.attemptId !== state.attemptId ||
    attempt.source.environmentId !== source.environmentId ||
    attempt.source.threadId !== source.threadId ||
    endpointKey(attempt.destination) !== endpointKey(destination) ||
    attempt.text !== state.request.content ||
    command.type !== "message.steer-strict" ||
    command.commandId !== `command:route-steer:${identity}` ||
    command.messageId !== `message:route-steer:${identity}` ||
    command.threadId !== destination.threadId ||
    command.text !== attempt.text ||
    command.createdBy !== "agent" ||
    command.creationSource !== "server" ||
    command.senderThreadId !== expectedSender ||
    command.linkedSender !== undefined ||
    strictRouteDescriptorFingerprint(command.attachments) !== strictRouteDescriptorFingerprint(attempt.attachments) ||
    target.projectId !== destination.projectId ||
    target.providerInstanceId !== attempt.destination.providerInstanceId ||
    target.runId !== attempt.destination.runId ||
    target.runtimeMode !== attempt.destination.runtimeMode ||
    target.interactionMode !== attempt.destination.interactionMode
  ) throw new Error("Strict route submission identity mismatch");
}

export function claimStrictRouteSubmission(
  state: RouteState,
  fingerprint: string,
  delivery: PreparedStrictRouteDelivery,
): RouteState {
  if (state.status !== "sending" || state.strictSubmission !== undefined || state.idleSubmission !== undefined) {
    throw new Error("Strict route submission claim is unavailable");
  }
  const claimed = {
    ...state,
    strictSubmission: {
      routeFingerprint: fingerprint,
      descriptorFingerprint: strictRouteDescriptorFingerprint(delivery),
      delivery: structuredClone(delivery),
    },
  };
  assertStrictRouteSubmission(claimed);
  return claimed;
}

export function settleStrictRouteSubmission(
  state: RouteState,
  descriptorFingerprint: string,
  result: StrictRouteDeliveryResult,
): RouteState {
  const claim = state.strictSubmission;
  const destination = state.request.destination;
  if (
    claim === undefined || destination === null || state.attemptId === null ||
    claim.descriptorFingerprint !== descriptorFingerprint
  ) throw new Error("Strict route settlement identity mismatch");
  if (
    "effectId" in result &&
    result.effectId !== `effect:strict-steer:${strictRouteDescriptorFingerprint(claim.delivery.command)}`
  ) throw new Error("Strict route effect identity mismatch");

  if (!["sending", "admitted", "uncertain"].includes(state.status)) return state;
  switch (result.status) {
    case "admitted":
      return state.status === "admitted" ? state : {
        ...state, status: "admitted", reason: "strict-steer-awaiting-native-result",
      };
    case "uncertain":
      return state.status === "uncertain" ? state : applyRouteTransition(state, { type: "send-interrupted" });
    case "rejected":
      // A mismatch during reconciliation is not evidence about the original submission.
      return result.reason === "changed-intent"
        ? state.status === "uncertain" ? state : applyRouteTransition(state, { type: "send-interrupted" })
        : { ...state, status: "failed", reason: "strict-steer-command-rejected" };
    case "delivered":
    case "failed":
    case "cancelled": {
      const kind = result.status === "delivered" ? "delivered" : "failed";
      const receipt: RouteReceipt = {
        requestId: state.request.requestId,
        fingerprint: state.fingerprint,
        attemptId: state.attemptId,
        destination,
        receiptId: `strict:${result.effectId}:${kind}`,
        kind,
        ...(kind === "failed" ? { message: "Strict steering ended without confirmed native delivery." } : {}),
      };
      return applyRouteTransition(state, { type: "receipt", receipt });
    }
  }
}
