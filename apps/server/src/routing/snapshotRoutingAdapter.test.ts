import { ThreadId, ProjectId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makeSnapshotRoutingAdapter, type SnapshotRoutingFacts } from "./snapshotRoutingAdapter.ts";
import { registerRoute } from "./routeState.ts";

const source = { environmentId: "local", projectId: "project", threadId: "source" };
const destination = { ...source, threadId: "destination" };
function setup(overrides: Partial<SnapshotRoutingFacts> = {}) {
  return makeSnapshotRoutingAdapter({
    environmentId: "local",
    thread: (id) =>
      Effect.succeed({
        id: ThreadId.make(id),
        projectId: ProjectId.make("project"),
        archivedAt: null,
        session: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    settings: () => Effect.succeed({ chatRoutingMode: "auto" }),
    permissions: () => Effect.succeed(["read"]),
    ...overrides,
  });
}
describe("snapshot routing adapter", () => {
  it.effect("rejects archived, missing, foreign and project-mismatched endpoints", () =>
    Effect.gen(function* () {
      const missing = setup({ thread: () => Effect.succeed(null) });
      expect(yield* missing.current("local", "missing")).toBeNull();
      const archived = setup({
        thread: (id) =>
          Effect.succeed({
            id: ThreadId.make(id),
            projectId: ProjectId.make("project"),
            archivedAt: "2026-11-01T00:00:00Z",
            session: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
          }),
      });
      expect(yield* archived.current("local", "source")).toBeNull();
      expect(yield* setup().current("remote", "source")).toBeNull();
      expect(
        yield* setup()
          .inspect({ ...source, projectId: "other" })
          .pipe(Effect.flip),
      ).toBeDefined();
    }),
  );
  it.effect("keeps unknown owners and model candidates ambiguous even in Auto", () =>
    Effect.gen(function* () {
      const adapter = setup();
      expect(yield* adapter.owner(source, "task")).toEqual({ destination: null, ambiguous: true });
      expect(yield* adapter.owner(source, "task", destination)).toEqual({
        destination,
        ambiguous: true,
      });
    }),
  );
  for (const mode of ["off", "suggest", "auto"] as const)
    it.effect(`reads ${mode} policy without fabricating manual authority`, () =>
      Effect.gen(function* () {
        const adapter = setup({ settings: () => Effect.succeed({ chatRoutingMode: mode }) });
        expect(yield* adapter.policy(source, "id")).toEqual({
          mode,
          manual: false,
          visited: [],
          maxHops: 1,
        });
      }),
    );
  it.effect("fails closed for unknown permissions and blocks a capability mismatch", () =>
    Effect.gen(function* () {
      expect(
        yield* setup({ permissions: () => Effect.succeed(null) })
          .inspect(source)
          .pipe(Effect.flip),
      ).toBeDefined();
      const adapter = setup({
        permissions: (e) => Effect.succeed(e.threadId === "source" ? ["read"] : ["read", "write"]),
      });
      const s = yield* adapter.inspect(source);
      const d = yield* adapter.inspect(destination);
      const route = registerRoute({
        requestId: "id",
        source,
        destination,
        content: "original",
        permissionCeiling: s.permissions,
        destinationPermissions: d.permissions,
        mode: "auto",
        initiation: "automatic",
        ambiguous: false,
        visited: [],
        maxHops: 1,
      });
      expect(route.status).toBe("blocked");
      expect(route.reason).toBe("permission-escalation");
    }),
  );
});
