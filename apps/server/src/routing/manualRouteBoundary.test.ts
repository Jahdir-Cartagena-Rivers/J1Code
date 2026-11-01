import { describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { makeManualRouteBoundary } from "./manualRouteBoundary.ts";
import { registerRoute, transitionRoute, type RouteEndpoint } from "./routeState.ts";

const source = { environmentId: "local", projectId: "home", threadId: "source" };
const destination = { environmentId: "local", projectId: "work", threadId: "target" };
function fixture() {
  let stored = {
    revision: 0,
    state: registerRoute({
      requestId: "r",
      source,
      destination: null,
      content: "work",
      permissionCeiling: ["read"],
      destinationPermissions: [],
      visited: [],
      maxHops: 2,
      ambiguous: true,
      mode: "suggest",
      initiation: "automatic",
    }),
  };
  let session: AuthenticatedSession = {
    sessionId: AuthSessionId.make("s"),
    subject: "user",
    method: "browser-session-cookie",
    scopes: [AuthOrchestrationOperateScope, AuthOrchestrationReadScope],
  };
  let permissions: readonly string[] | null = ["read"];
  let available = true;
  let mismatch = false;
  const boundary = makeManualRouteBoundary({
    environmentId: "local",
    authenticate: async () => session,
    get: async () => stored,
    list: async () => ["r"],
    inspect: async (_session, endpoint: RouteEndpoint) =>
      available
        ? {
            endpoint: mismatch ? { ...endpoint, projectId: "wrong" } : endpoint,
            permissions: endpoint.threadId === source.threadId ? ["read"] : permissions,
          }
        : null,
    commit: async (_id, revision, state) => {
      if (revision !== stored.revision) throw new Error("CAS conflict");
      stored = { revision: revision + 1, state };
      return stored;
    },
  });
  return {
    boundary,
    get: () => stored,
    set: (value: typeof stored) => {
      stored = value;
    },
    revoke: () => {
      session = { ...session, scopes: [] };
    },
    permissions: (value: readonly string[] | null) => {
      permissions = value;
    },
    unavailable: () => {
      available = false;
    },
    mismatch: () => {
      mismatch = true;
    },
  };
}

it("lists readable request summaries only after source authorization", async () => {
  const { boundary, revoke } = fixture();
  expect(await boundary.list(source)).toMatchObject([
    {
      requestId: "r",
      summary: "work",
      status: "suggested",
      delivered: false,
      accepted: false,
      completed: false,
    },
  ]);
  await expect(boundary.list({ ...source, threadId: "unrelated" })).rejects.toThrow();
  revoke();
  await expect(boundary.list(source)).rejects.toThrow();
});
describe("manual authenticated route boundary", () => {
  it("resolves an ambiguous route only after the explicit selected action; rejects replay", async () => {
    const f = fixture();
    await expect(f.boundary.confirm("model-asserted-authority")).rejects.toThrow("user action");
    const { token } = await f.boundary.prepare("r", source, destination);
    expect(f.get().state.status).toBe("suggested");
    expect((await f.boundary.confirm(token)).state.status).toBe("queued");
    await expect(f.boundary.confirm(token)).rejects.toThrow("consumed");
  });
  it("binds exact source environment and project", async () => {
    const f = fixture();
    await expect(
      f.boundary.prepare("r", { ...source, environmentId: "other" }, destination),
    ).rejects.toThrow("environment");
    await expect(
      f.boundary.prepare("r", { ...source, projectId: "other" }, destination),
    ).rejects.toThrow("source mismatch");
    f.mismatch();
    await expect(f.boundary.prepare("r", source, destination)).rejects.toThrow("unavailable");
  });
  it.each(["revoked", "escalated", "unknown", "unavailable", "stale"])(
    "rejects %s at confirmation",
    async (kind) => {
      const f = fixture();
      const { token } = await f.boundary.prepare("r", source, destination);
      if (kind === "revoked") f.revoke();
      if (kind === "escalated") f.permissions(["write"]);
      if (kind === "unknown") f.permissions(null);
      if (kind === "unavailable") f.unavailable();
      if (kind === "stale") f.set({ ...f.get(), revision: 1 });
      await expect(f.boundary.confirm(token)).rejects.toThrow();
      expect(f.get().state.status).toBe("suggested");
      await expect(f.boundary.confirm(token)).rejects.toThrow("consumed");
    },
  );
  it("keeps delivery separate from acceptance and completion", async () => {
    const f = fixture();
    const { token } = await f.boundary.prepare("r", source, destination);
    await f.boundary.confirm(token);
    let state = transitionRoute(f.get().state, { type: "begin-send", attemptId: "a" });
    state = transitionRoute(state, {
      type: "receipt",
      receipt: {
        receiptId: "d",
        requestId: "r",
        fingerprint: state.fingerprint,
        attemptId: "a",
        destination,
        kind: "delivered",
      },
    });
    f.set({ revision: 3, state });
    expect(await f.boundary.status("r", source)).toMatchObject({
      delivered: true,
      accepted: false,
      completed: false,
      failed: false,
    });
    f.revoke();
    await expect(f.boundary.status("r", source)).rejects.toThrow("Unauthorized");
  });
});
