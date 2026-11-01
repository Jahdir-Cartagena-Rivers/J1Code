import { describe, expect, it } from "vite-plus/test";
import {
  registerRoute,
  resolveRoute,
  transitionRoute,
  type RouteRequest,
  type RouteState,
  type RouteReceipt,
} from "./routeState.ts";

const source = { environmentId: "local", projectId: "home", threadId: "home" };
const destination = { environmentId: "remote", projectId: "project", threadId: "work" };
const request: RouteRequest = {
  requestId: "request-1",
  source,
  destination,
  content: "Investigate this project",
  permissionCeiling: ["read"],
  destinationPermissions: ["read"],
  visited: [],
  maxHops: 3,
  ambiguous: false,
  mode: "auto",
  initiation: "automatic",
};
function sending() {
  return transitionRoute(registerRoute(request), { type: "begin-send", attemptId: "attempt-1" });
}
function receipt(state: RouteState, kind: RouteReceipt["kind"]): RouteReceipt {
  return {
    receiptId: `receipt-${kind}`,
    requestId: request.requestId,
    fingerprint: state.fingerprint,
    attemptId: "attempt-1",
    destination,
    kind,
  };
}
function receive(state: RouteState, kind: RouteReceipt["kind"]) {
  return transitionRoute(state, { type: "receipt", receipt: receipt(state, kind) });
}

describe("route delivery state", () => {
  it.each([
    ["off", "automatic", "blocked"],
    ["suggest", "automatic", "suggested"],
    ["auto", "automatic", "queued"],
    ["off", "manual", "queued"],
    ["suggest", "manual", "queued"],
    ["auto", "manual", "queued"],
  ] as const)("%s / %s produces %s", (mode, initiation, status) => {
    expect(registerRoute({ ...request, mode, initiation }).status).toBe(status);
  });
  it("requires confirmation for suggestions without treating confirmation as delivery", () => {
    const suggested = registerRoute({ ...request, mode: "suggest" });
    expect(() => transitionRoute(suggested, { type: "begin-send", attemptId: "a" })).toThrow();
    expect(() => transitionRoute(suggested, { type: "confirm" })).toThrow();
    expect(
      resolveRoute(suggested, {
        authenticatedUser: true,
        userId: "user",
        source,
        destination,
        destinationPermissions: ["read"],
      }).status,
    ).toBe("queued");
  });
  it.each([
    [{ destination: null }, "missing-destination"],
    [{ destination: source }, "routing-loop"],
    [{ visited: [destination] }, "routing-loop"],
    [{ visited: [source] }, "routing-loop"],
    [{ maxHops: 0 }, "hop-limit"],
    [{ visited: [destination], maxHops: 1 }, "hop-limit"],
    [{ destinationPermissions: ["read", "write"] }, "permission-escalation"],
  ] satisfies [Partial<RouteRequest>, string][])("blocks unsafe routing %j", (patch, reason) => {
    const state = registerRoute({ ...request, ...patch, initiation: "manual" });
    expect(state.status).toBe("blocked");
    expect(state.reason).toBe(reason);
    expect(() => transitionRoute(state, { type: "confirm" })).toThrow();
  });
  it("suggests ambiguous auto routes and never confirms an unresolved destination", () => {
    const state = registerRoute({ ...request, ambiguous: true });
    expect(state.status).toBe("suggested");
    expect(state.reason).toBe("ambiguous-destination");
    expect(() => transitionRoute(state, { type: "confirm" })).toThrow();
  });
  it("deduplicates identical requests and rejects changed content, authority or provenance", () => {
    const state = sending();
    expect(registerRoute({ ...request }, state)).toBe(state);
    for (const patch of [
      { content: "changed" },
      { permissionCeiling: ["write"] },
      { source: destination },
      { taskId: "changed" },
      { sourceUrl: "changed" },
      { requestId: "new" },
    ]) {
      expect(() => registerRoute({ ...request, ...patch }, state)).toThrow("identity conflict");
    }
  });
  it("snapshots input provenance rather than retaining mutable caller data", () => {
    const input = { ...structuredClone(request) };
    const state = registerRoute(input);
    input.permissionCeiling = ["write"];
    expect(state.request.permissionCeiling).toEqual(["read"]);
  });
  it("advances delivery, acceptance and completion only through ordered receipts", () => {
    const state = sending();
    expect(state.status).toBe("sending");
    expect(() => receive(state, "accepted")).toThrow();
    const delivered = receive(state, "delivered");
    expect(delivered.status).toBe("delivered");
    expect(() => receive(delivered, "completed")).toThrow();
    const accepted = receive(delivered, "accepted");
    expect(accepted.status).toBe("accepted");
    const completed = receive(accepted, "completed");
    expect(completed.status).toBe("completed");
    expect(receive(completed, "delivered")).toBe(completed);
    expect(() => receive(completed, "failed")).toThrow();
  });
  it("holds a crash after possible send as uncertain until reconciliation", () => {
    const uncertain = transitionRoute(sending(), { type: "send-interrupted" });
    expect(uncertain.status).toBe("uncertain");
    expect(registerRoute(request, uncertain)).toBe(uncertain);
    expect(() => transitionRoute(uncertain, { type: "begin-send", attemptId: "retry" })).toThrow();
    expect(receive(uncertain, "delivered").status).toBe("delivered");
    expect(receive(uncertain, "failed").status).toBe("failed");
  });
  it("rejects receipts for another request, fingerprint, attempt or destination", () => {
    const state = sending();
    for (const patch of [
      { requestId: "other" },
      { fingerprint: "other" },
      { attemptId: "other" },
      { destination: source },
      { receiptId: "" },
    ]) {
      expect(() =>
        transitionRoute(state, {
          type: "receipt",
          receipt: { ...receipt(state, "delivered"), ...patch },
        }),
      ).toThrow("identity mismatch");
    }
  });
  it("keeps explicit failures terminal and rejects conflicting receipt reuse", () => {
    const state = receive(sending(), "failed");
    expect(registerRoute(request, state)).toBe(state);
    expect(() => transitionRoute(state, { type: "begin-send", attemptId: "retry" })).toThrow();
    expect(() =>
      transitionRoute(state, {
        type: "receipt",
        receipt: { ...receipt(state, "completed"), receiptId: "receipt-failed" },
      }),
    ).toThrow("identity conflict");
  });
});

it("records persisted admission without fabricating provider receipts", () => {
  const admitted = transitionRoute(sending(), { type: "admitted" });
  expect(admitted.status).toBe("admitted");
  expect(admitted.receipts).toEqual([]);
  expect(transitionRoute(admitted, { type: "send-interrupted" }).status).toBe("uncertain");
  expect(() => transitionRoute(admitted, { type: "begin-send", attemptId: "retry" })).toThrow();
  expect(() =>
    transitionRoute(admitted, { type: "receipt", receipt: receipt(admitted, "completed") }),
  ).toThrow();
  expect(receive(admitted, "delivered").status).toBe("delivered");
  expect(receive(admitted, "failed").status).toBe("failed");
});
it("only definite admission rejection returns an attempt to the queue", () => {
  const held = transitionRoute(sending(), { type: "admission-rejected" });
  expect(held.status).toBe("queued");
  expect(held.attemptId).toBeNull();
  const uncertain = transitionRoute(sending(), { type: "send-interrupted" });
  expect(() => transitionRoute(uncertain, { type: "admission-rejected" })).toThrow();
});

it.each(["suggest", "auto"] as const)(
  "resolves null ambiguous %s intent only with safe trusted facts",
  (mode) => {
    const original = {
      ...request,
      destination: null,
      ambiguous: true,
      mode,
      taskId: "task",
      sourceUrl: "j1://source",
    };
    const suggested = registerRoute(original);
    expect(suggested.status).toBe("suggested");
    const authority = {
      authenticatedUser: true as const,
      userId: "user",
      source,
      destination,
      destinationPermissions: ["read"],
    };
    const resolved = resolveRoute(suggested, authority);
    expect(resolved.originalRequest).toEqual(original);
    expect(resolved.request.destination).toEqual(destination);
    expect(resolved.fingerprint).toBe(suggested.fingerprint);
    expect(resolved.receipts).toEqual([]);
    expect(registerRoute({ ...original, destination, ambiguous: false }, resolved)).toBe(resolved);
    expect(() => registerRoute({ ...original, content: "redirect" }, resolved)).toThrow(
      "identity conflict",
    );
    expect(() =>
      resolveRoute(suggested, {
        ...authority,
        authenticatedUser: false,
      } as unknown as typeof authority),
    ).toThrow("Unauthorized");
    expect(() => resolveRoute(suggested, { ...authority, source: destination })).toThrow(
      "Unauthorized",
    );
    expect(() => resolveRoute(suggested, { ...authority, destination: source })).toThrow(
      "routing-loop",
    );
    expect(() =>
      resolveRoute(suggested, { ...authority, destinationPermissions: ["write"] }),
    ).toThrow("permission-escalation");
    expect(() => resolveRoute(resolved, authority)).toThrow();
  },
);
