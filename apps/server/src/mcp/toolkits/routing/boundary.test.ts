import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { registerRoute, type RouteState } from "../../../routing/routeState.ts";
import {
  routeRequest,
  routeStatus,
  listRoutes,
  RoutingBoundaryPorts,
  type RoutingPorts,
} from "./boundary.ts";

const source = { environmentId: "env", threadId: "source", projectId: "project" };
const destination = { ...source, threadId: "owner" };
const input = { requestId: "stable", taskId: "task", request: "Original request" };
function fixture(
  options: {
    mode?: "off" | "suggest" | "auto";
    manual?: boolean;
    ambiguous?: boolean;
    missing?: boolean;
  } = {},
) {
  const states = new Map<string, { fingerprint: string; state: RouteState }>();
  const submitted: Parameters<RoutingPorts["submit"]>[0][] = [];
  const ports: RoutingPorts = {
    current: (env, thread) =>
      Effect.succeed(
        options.missing && thread === "owner"
          ? null
          : { ...source, environmentId: env, threadId: thread },
      ),
    policy: () =>
      Effect.succeed({
        mode: options.mode ?? "auto",
        manual: options.manual ?? false,
        visited: [],
        maxHops: 4,
      }),
    owner: () => Effect.succeed({ destination, ambiguous: options.ambiguous ?? false }),
    submit: (value) =>
      Effect.try({
        try: () => {
          const previous = states.get(value.route.requestId);
          if (previous && previous.fingerprint !== value.fingerprint)
            throw new Error("duplicate mismatch");
          const state =
            previous?.state ??
            registerRoute({
              ...value.route,
              permissionCeiling: ["read"],
              destinationPermissions: ["read"],
            });
          states.set(value.route.requestId, { fingerprint: value.fingerprint, state });
          submitted.push(value);
          return state;
        },
        catch: () => "duplicate mismatch",
      }),
    get: (id) => Effect.succeed(states.get(id)?.state ?? null),
    list: () => Effect.succeed([...states.values()].map((x) => x.state)),
  };
  const run = <A, E>(
    effect: Effect.Effect<A, E, McpInvocationContext | RoutingBoundaryPorts>,
    thread = "source",
  ) =>
    effect.pipe(
      Effect.provideService(RoutingBoundaryPorts, ports),
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make(thread),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["agents"] as const),
        issuedAt: 0,
      }),
    );
  return { run, submitted };
}
describe("unregistered routing MCP boundary", () => {
  it.effect("binds provenance and rejects forged authority", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run(routeRequest(input));
      expect(f.submitted[0]).toMatchObject({
        originalRequest: input.request,
        sourceUrl: "/env/source",
        route: { source, destination },
      });
      for (const field of ["source", "permissionCeiling", "mode", "manual", "receipts"]) {
        expect(yield* f.run(routeRequest({ ...input, [field]: "forged" })).pipe(Effect.flip)).toBe(
          "Invalid routing input.",
        );
      }
      expect(f.submitted).toHaveLength(1);
    }),
  );
  for (const [mode, manual, ambiguous, expected] of [
    ["off", false, false, "blocked"],
    ["suggest", false, false, "suggested"],
    ["auto", false, false, "queued"],
    ["off", true, false, "queued"],
    ["suggest", true, false, "queued"],
    ["auto", false, true, "suggested"],
    ["auto", true, true, "suggested"],
  ] as const) {
    it.effect(`${mode} manual=${manual} ambiguous=${ambiguous}: ${expected}`, () =>
      Effect.gen(function* () {
        const f = fixture({ mode, manual, ambiguous });
        expect((yield* f.run(routeRequest(input))).status).toBe(expected);
      }),
    );
  }
  it.effect("rejects unavailable destination before persistence", () =>
    Effect.gen(function* () {
      const f = fixture({ missing: true });
      expect(yield* f.run(routeRequest(input)).pipe(Effect.flip)).toBe("Destination unavailable.");
      expect(f.submitted).toHaveLength(0);
    }),
  );
  it.effect("identical retries preserve identity; changed intent rejects", () =>
    Effect.gen(function* () {
      const f = fixture();
      const first = yield* f.run(routeRequest(input));
      expect(yield* f.run(routeRequest(input))).toEqual(first);
      expect(yield* f.run(routeRequest({ ...input, request: "Different" })).pipe(Effect.flip)).toBe(
        "duplicate mismatch",
      );
    }),
  );
  it.effect("status/list reject unrelated receiving identity", () =>
    Effect.gen(function* () {
      const f = fixture();
      const state = yield* f.run(routeRequest(input));
      expect(yield* f.run(routeStatus(state.request.requestId), "owner")).toEqual(state);
      expect(
        yield* f.run(routeStatus(state.request.requestId), "wrong-destination").pipe(Effect.flip),
      ).toBe("Route unavailable.");
      expect(yield* f.run(listRoutes, "wrong-destination")).toEqual([]);
    }),
  );
});
