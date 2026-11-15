import { describe, expect, it } from "vite-plus/test";
import { automaticRouteFeedback, createRouteFeedback } from "./feedback.ts";
import {
  registerRoute,
  transitionRoute,
  type RouteReceipt,
  type RouteRequest,
} from "./routeState.ts";

const source = { environmentId: "env", projectId: "project", threadId: "source" };
const destination = { ...source, threadId: "destination" };
const request: RouteRequest = {
  requestId: "original",
  source,
  destination,
  content: "Fix the requested bug",
  monitorSource: true,
  permissionCeiling: ["runtime:full-access"],
  destinationPermissions: ["runtime:full-access"],
  visited: [],
  maxHops: 8,
  ambiguous: false,
  mode: "auto",
  initiation: "automatic",
};
function accepted() {
  let state = transitionRoute(registerRoute(request), { type: "begin-send", attemptId: "attempt" });
  for (const kind of ["delivered", "accepted"] as const) {
    state = transitionRoute(state, {
      type: "receipt",
      receipt: {
        receiptId: kind,
        requestId: "original",
        fingerprint: state.fingerprint,
        attemptId: "attempt",
        destination,
        kind,
      },
    });
  }
  return state;
}

describe("linked routing feedback", () => {
  it("returns acceptance and completion through independently tracked, non-looping routes", () => {
    const state = accepted();
    const update = automaticRouteFeedback(state)!;
    expect(update.source).toEqual(destination);
    expect(update.destination).toEqual(source);
    expect(update.feedbackFor).toBe("original");
    expect(registerRoute(update).status).toBe("queued");
    expect(automaticRouteFeedback({ ...state, request: update })).toBeNull();
    const completed = transitionRoute(state, {
      type: "receipt",
      receipt: {
        receiptId: "completed",
        requestId: "original",
        fingerprint: state.fingerprint,
        attemptId: "attempt",
        destination,
        kind: "completed",
        message: "Already fixed in commit abc; tests passed.",
      },
    });
    const result = automaticRouteFeedback(completed)!;
    expect(result.requestId).not.toBe(update.requestId);
    expect(result.content).toContain("Already fixed in commit abc");
    expect(result.content).toContain("not a fresh request to execute it again");
    expect(result.content).toContain("/env/destination");
  });

  it("lets either original participant ask a substantive follow-up after completion", () => {
    const state = { ...accepted(), status: "completed" as const };
    expect(createRouteFeedback(state, source, "reply-1", "Which commit?").destination).toEqual(
      destination,
    );
    expect(createRouteFeedback(state, destination, "reply-2", "Commit abc.").destination).toEqual(
      source,
    );
    expect(() =>
      createRouteFeedback(state, { ...source, threadId: "outsider" }, "reply", "Forged"),
    ).toThrow();
    expect(() =>
      createRouteFeedback(registerRoute(request), source, "reply", "Not admitted"),
    ).toThrow();
  });

  it("bounds permissions and refuses changed content under the same reply identity", () => {
    const state = accepted();
    const reply = createRouteFeedback(state, destination, "reply", "The result");
    const stored = registerRoute(reply);
    expect(registerRoute(reply, stored)).toBe(stored);
    expect(() => registerRoute({ ...reply, content: "Different result" }, stored)).toThrow(
      "identity conflict",
    );
    const limited = createRouteFeedback(
      {
        ...state,
        request: {
          ...state.request,
          permissionCeiling: ["read", "write"],
          destinationPermissions: ["read"],
        },
      },
      destination,
      "limited",
      "A report",
    );
    expect(limited.permissionCeiling).toEqual(["read"]);
  });

  it("does not resurrect historical routes or manufacture a recipient result", () => {
    const state = accepted();
    const historical = { ...request };
    delete historical.monitorSource;
    expect(automaticRouteFeedback({ ...state, request: historical })).toBeNull();
    expect(automaticRouteFeedback({ ...state, status: "delivered" })).toBeNull();
    expect(automaticRouteFeedback({ ...state, status: "failed", receipts: [] })).toBeNull();
    const receipt: RouteReceipt = { ...state.receipts[1]!, message: "Different acceptance" };
    expect(() => transitionRoute(state, { type: "receipt", receipt })).toThrow("identity conflict");
  });
});
