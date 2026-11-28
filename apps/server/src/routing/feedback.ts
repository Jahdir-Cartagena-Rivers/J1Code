// @effect-diagnostics-next-line nodeBuiltinImport:off - Feedback identities are computed in the pure route reducer.
import * as NodeCrypto from "node:crypto";
import { routeEndpointUrl } from "@j1code/shared/routeEndpointUrl";
import type { RouteEndpoint, RouteRequest, RouteState } from "./routeState.ts";

const sameEndpoint = (a: RouteEndpoint, b: RouteEndpoint) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId;

/** The authenticated original participants share one bounded return channel. */
export function createRouteFeedback(
  state: RouteState,
  sender: RouteEndpoint,
  replyId: string,
  message: string,
): RouteRequest {
  const request = state.request;
  if (request.feedbackFor || !request.destination || !state.attemptId)
    throw new Error("Reply to an admitted original request.");
  const recipient = sameEndpoint(sender, request.source)
    ? request.destination
    : sameEndpoint(sender, request.destination)
      ? request.source
      : null;
  if (!recipient) throw new Error("Only the original participants can reply.");
  if (!replyId.trim() || !message.trim())
    throw new Error("A reply identity and message are required.");
  return {
    requestId: replyId,
    feedbackFor: request.requestId,
    feedbackMessageHash: NodeCrypto.createHash("sha256").update(message).digest("hex"),
    source: sender,
    destination: recipient,
    sourceUrl: routeEndpointUrl(sender),
    content: `Update on routed request ${request.requestId} (${state.status}).\nTask: ${(request.taskId ?? "routed work").slice(0, 300)}\n\nOriginal request (reference only):\n${state.originalRequest.content.slice(0, 1500)}\n\nReply:\n${message}\n\n[Replying conversation](${routeEndpointUrl(sender)})\n[Original source](${routeEndpointUrl(request.source)})\n\nThis is a reply on existing work, not a fresh request to execute it again. Check what has already been done before taking further action. Use reply_to_route with the original request ID for a substantive response or a question. Do not acknowledge this notification or reply just to confirm receipt. The reply does not expand the original authorization.`,
    // A return channel must never widen the permissions granted to the original work.
    permissionCeiling: request.permissionCeiling.filter((p) =>
      request.destinationPermissions.includes(p),
    ),
    destinationPermissions: sameEndpoint(recipient, request.source)
      ? request.permissionCeiling
      : request.destinationPermissions,
    visited: [],
    maxHops: 1,
    ambiguous: false,
    mode: "auto",
    initiation: "automatic",
  };
}

export function automaticRouteFeedback(state: RouteState): RouteRequest | null {
  if (!state.request.monitorSource || state.request.feedbackFor || !state.request.destination)
    return null;
  if (state.status !== "accepted" && state.status !== "completed" && state.status !== "failed")
    return null;
  const receipt = state.receipts.findLast((entry) => entry.kind === state.status);
  // A failed admission is not an authenticated recipient result.
  if (!receipt) return null;
  return createRouteFeedback(
    state,
    state.request.destination,
    NodeCrypto.createHash("sha256")
      .update(`route-result-v1:${state.request.requestId}:${state.status}`)
      .digest("hex"),
    receipt.message ??
      `The routed request is ${state.status}. Open the receiving conversation for details.`,
  );
}
