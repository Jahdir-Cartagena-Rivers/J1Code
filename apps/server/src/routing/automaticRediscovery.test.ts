import { expect, it } from "vite-plus/test";
import { registerRoute, resolveDiscoveredOwner } from "./routeState.ts";
const source = { environmentId: "env", projectId: "project", threadId: "source" };
const destination = { ...source, threadId: "owner" };
const request = {
  requestId: "request",
  source,
  destination: null,
  content: "Integrate audio changes",
  permissionCeiling: ["read"],
  destinationPermissions: [],
  visited: [],
  maxHops: 8,
  ambiguous: true,
  mode: "auto",
  initiation: "automatic",
} as const;
it("reconsiders Auto ambiguity without changing original identity or fabricating user approval", () => {
  const state = registerRoute(request);
  const updated = resolveDiscoveredOwner(state, destination, ["read"]);
  expect(updated.status).toBe("queued");
  expect(updated.fingerprint).toBe(state.fingerprint);
  expect(updated.originalRequest).toEqual(state.originalRequest);
  expect(updated.resolution).toBeNull();
  expect(() => resolveDiscoveredOwner(updated, destination, ["read"])).toThrow();
});
it("does not auto-approve Suggest, Off, broader permissions, or loops", () => {
  for (const mode of ["suggest", "off"] as const)
    expect(() =>
      resolveDiscoveredOwner(registerRoute({ ...request, mode }), destination, ["read"]),
    ).toThrow();
  const state = registerRoute(request);
  expect(() => resolveDiscoveredOwner(state, destination, ["read", "write"])).toThrow(
    "permission-escalation",
  );
  expect(() => resolveDiscoveredOwner(state, source, ["read"])).toThrow("routing-loop");
});
