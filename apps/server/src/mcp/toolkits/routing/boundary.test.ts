import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@j1code/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { registerBotExecutionContext } from "../../../mausbot/ExecutionContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  DEEPAI_INVOCATION_HEADER,
  type DeepAIInvocationOrigin,
  deepAIMcpFetch,
  resolveDeepAIInvocation,
  withDeepAIInvocation,
} from "../../../provider/deepai/DeepAIMcpInvocation.ts";
import { registerRoute, bindRouteInputFingerprint, type RouteState } from "../../../routing/routeState.ts";
import {
  routeRequest as registerNativeRoute,
  currentEndpoint,
  makeRoutingBoundary,
  routeStatus,
  listRoutes,
  RoutingBoundaryPorts,
  type RoutingPorts,
} from "./boundary.ts";

const { routeRequest } = makeRoutingBoundary(currentEndpoint);

const source = { environmentId: "env", threadId: "source", projectId: "project" };
const destination = { ...source, threadId: "owner" };
const input = { requestId: "stable", taskId: "task", request: "Original request" };
function fixture(
  options: {
    mode?: "off" | "suggest" | "auto";
    manual?: boolean;
    ambiguous?: boolean;
    missing?: boolean;
    foreignProject?: boolean;
    wrongProvider?: boolean;
    beforeOwner?: () => void;
    beforeList?: () => void;
  } = {},
) {
  let discoveryBlocked = false;
  const states = new Map<string, { fingerprint: string; state: RouteState }>();
  const submitted: Parameters<RoutingPorts["submit"]>[0][] = [];
  const ports: RoutingPorts = {
    current: (env, thread) =>
      Effect.succeed(
        options.missing && thread === "owner"
          ? null
          : { ...source, environmentId: env, threadId: thread,
              projectId: options.foreignProject && thread === "source" ? "other-project" : source.projectId },
      ),
    policy: () => discoveryBlocked ? Effect.die("Saved retry rediscovered policy") :
      Effect.succeed({
        mode: options.mode ?? "auto",
        manual: options.manual ?? false,
        visited: [],
        maxHops: 4,
      }),
    owner: () => discoveryBlocked ? Effect.die("Saved retry rediscovered owner") : Effect.sync(() => {
      options.beforeOwner?.();
      return { destination, ambiguous: options.ambiguous ?? false };
    }),
    submit: (value) =>
      Effect.try({
        try: () => {
          const previous = states.get(value.route.requestId);
          if (previous && previous.fingerprint !== value.fingerprint)
            throw new Error("duplicate mismatch");
          const state =
            previous?.state ??
            bindRouteInputFingerprint(registerRoute({
              ...value.route,
              permissionCeiling: ["read"],
              destinationPermissions: ["read"],
            }), value.fingerprint);
          states.set(value.route.requestId, { fingerprint: value.fingerprint, state });
          submitted.push(value);
          return state;
        },
        catch: () => "duplicate mismatch",
      }),
    get: (id) => Effect.succeed(states.get(id)?.state ?? null),
    list: () => Effect.sync(() => {
      options.beforeList?.();
      return [...states.values()].map((x) => x.state);
    }),
  };
  const threadLayer = Layer.mock(ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed({
      ...liveThreadShell(id),
      projectId: ProjectId.make(source.projectId),
      providerInstanceId: ProviderInstanceId.make(options.wrongProvider ? "foreign" : "codex"),
    }),
  });
  const run = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    thread = "source",
    overrides: Partial<McpInvocationScope> = {},
  ) =>
    effect.pipe(
      Effect.provideService(RoutingBoundaryPorts, ports),
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("env"),
        thread: {
          threadId: ThreadId.make(thread),
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "routing-test",
        capabilities: new Set(["agents"] as const),
        issuedAt: 0,
        ...overrides,
      }),
      Effect.provideService(ServerEnvironment, { getEnvironmentId: Effect.succeed(EnvironmentId.make("env")) } as never),
      Effect.provide(threadLayer),
    );
  return { run, submitted, blockDiscovery: () => { discoveryBlocked = true; } };
}
// The native transport owns its cancellation signal. Keep it alive until the test scope closes.
async function openNativeInvocation(identity: DeepAIInvocationOrigin) {
  const controller = new AbortController();
  const endpoint = "http://localhost/mcp";
  const ready = Promise.withResolvers<Readonly<DeepAIInvocationOrigin>>();
  const close = Promise.withResolvers<void>();
  const invocation = withDeepAIInvocation(identity, controller.signal, async () => {
    const transport = deepAIMcpFetch(endpoint, async (_url, init) => {
      const token = new Headers(init?.headers).get(DEEPAI_INVOCATION_HEADER) ?? undefined;
      const origin = resolveDeepAIInvocation(token, identity);
      if (!origin) throw new Error("Expected live native invocation provenance");
      ready.resolve(origin);
      await close.promise;
      return new Response(null, { status: 204 });
    });
    await transport(endpoint);
  });
  void invocation.catch(ready.reject);
  return {
    origin: await ready.promise,
    revoke: () => controller.abort(),
    close: async () => {
      close.resolve();
      await invocation;
    },
  };
}

const liveNativeOrigin = (identity: DeepAIInvocationOrigin) =>
  Effect.acquireRelease(
    Effect.promise(() => openNativeInvocation(identity)),
    (invocation) => Effect.promise(invocation.close),
  );

describe("unregistered routing MCP boundary", () => {
  it.effect("refuses new native calls without turn provenance before route submission", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.blockDiscovery();
      const late = yield* Effect.result(f.run(registerNativeRoute(input)));
      expect(late._tag).toBe("Failure");
      expect(f.submitted).toEqual([]);
    }),
  );
  it.effect("binds a live origin to its run and session and rejects revocation during discovery", () =>
    Effect.gen(function* () {
      const identity = {
        ...source,
        subject: "user:owner",
        runId: "run:mcp-test",
        messageId: "message:authored",
        providerSessionId: "session",
      };
      let revokeDuringDiscovery: (() => void) | undefined;
      let revokeDuringList: (() => void) | undefined;
      const f = fixture({
        beforeOwner: () => revokeDuringDiscovery?.(),
        beforeList: () => revokeDuringList?.(),
      });
      const scopeFor = (deepAIOrigin: Readonly<DeepAIInvocationOrigin>) => ({
        thread: {
          threadId: ThreadId.make(source.threadId),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: identity.providerSessionId,
          deepAIOrigin,
        },
      });
      const created = yield* Effect.scoped(Effect.gen(function* () {
        const { origin, revoke } = yield* liveNativeOrigin(identity);
        expect(origin).toEqual(identity);
        const scope = scopeFor(origin);
        const forgedSession = yield* f.run(
          registerNativeRoute(input).pipe(Effect.flip),
          "source",
          { thread: { ...scope.thread, providerSessionId: "other-session" } },
        );
        expect(forgedSession).toContain("no verified originating message");
        const result = yield* f.run(registerNativeRoute(input), "source", scope);
        expect(result.originalRequest.origin).toEqual({
          subject: identity.subject, runId: identity.runId, messageId: identity.messageId,
        });
        expect(yield* f.run(registerNativeRoute(input), "source", scope)).toEqual(result);
        expect(yield* f.run(listRoutes, "source", scope)).toEqual([result]);

        revokeDuringDiscovery = revoke;
        const revoked = yield* f.run(
          registerNativeRoute({ ...input, requestId: "late" }).pipe(Effect.flip),
          "source",
          scope,
        );
        expect(revoked).toContain("no verified originating message");
        expect(f.submitted).toHaveLength(1);
        return result;
      }));

      yield* Effect.scoped(Effect.gen(function* () {
        const { origin, revoke } = yield* liveNativeOrigin({ ...identity, runId: "run:earlier" });
        const scope = scopeFor(origin);
        const wrongRun = yield* f.run(registerNativeRoute(input).pipe(Effect.flip), "source", scope);
        expect(wrongRun).toContain("no verified originating message");
        revokeDuringList = revoke;
        expect(yield* f.run(listRoutes, "source", scope)).toEqual([]);
      }));
      expect(yield* f.run(routeStatus(created.request.requestId).pipe(Effect.flip)))
        .toBe("Route unavailable.");
    }),
  );
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
      f.blockDiscovery();
      expect((yield* f.run(routeRequest(input))).status).toBe("queued");
      for (const changed of [
        { ...input, request: "Changed request" },
        { ...input, candidate: { ...destination, threadId: "changed-candidate" } },
      ]) yield* f.run(routeRequest(changed)).pipe(Effect.flip);
      expect(f.submitted).toHaveLength(1);
    }),
  );
  it.effect.each([
    { mode: "off", manual: false, ambiguous: false, expected: "blocked" },
    { mode: "suggest", manual: false, ambiguous: false, expected: "suggested" },
    { mode: "auto", manual: false, ambiguous: false, expected: "queued" },
    { mode: "off", manual: true, ambiguous: false, expected: "queued" },
    { mode: "suggest", manual: true, ambiguous: false, expected: "queued" },
    { mode: "auto", manual: false, ambiguous: true, expected: "suggested" },
    { mode: "auto", manual: true, ambiguous: true, expected: "suggested" },
  ] as const)("$mode manual=$manual ambiguous=$ambiguous: $expected", ({ mode, manual, ambiguous, expected }) =>
    Effect.gen(function* () {
      const f = fixture({ mode, manual, ambiguous });
      expect((yield* f.run(routeRequest(input))).status).toBe(expected);
    }),
  );
  it.effect("rejects unavailable destination before persistence", () =>
    Effect.gen(function* () {
      const f = fixture({ missing: true });
      expect(yield* f.run(routeRequest(input)).pipe(Effect.flip)).toBe("Destination unavailable.");
      expect(f.submitted).toHaveLength(0);
    }),
  );
  it.effect("refuses outside, mixed, foreign-environment and stale provider callers", () =>
    Effect.gen(function* () {
      const client = { sessionId: "client", label: "Outside", access: "full-access" as const };
      const f = fixture();
      for (const scope of [
        { thread: undefined, client }, { client }, { environmentId: EnvironmentId.make("foreign") },
        { capabilities: new Set<never>() },
      ]) {
        yield* f.run(routeRequest(input), "source", scope).pipe(Effect.flip);
      }
      for (const blocked of [fixture({ foreignProject: true }), fixture({ wrongProvider: true })]) {
        yield* blocked.run(routeRequest(input)).pipe(Effect.flip);
        expect(blocked.submitted).toEqual([]);
      }
      expect(f.submitted).toEqual([]);
    }),
  );
  it.effect("refuses direct routing for a bot even with agents capability", () =>
    Effect.gen(function* () {
      const f = fixture();
      const dispose = registerBotExecutionContext(ThreadId.make("source"), {
        restrictedTools: false, prompt: "", tools: [], call: async () => undefined,
      });
      try {
        expect(yield* f.run(routeRequest(input)).pipe(Effect.flip)).toContain("bot_tools");
        expect(f.submitted).toEqual([]);
      } finally {
        dispose();
      }
      expect((yield* f.run(routeRequest(input))).status).toBe("queued");
    }),
  );
  it.effect("identical retries preserve identity; changed intent rejects", () =>
    Effect.gen(function* () {
      const f = fixture();
      const first = yield* f.run(routeRequest(input));
      expect(yield* f.run(routeRequest(input))).toEqual(first);
      expect(yield* f.run(routeRequest({ ...input, request: "Different" })).pipe(Effect.flip)).toBe(
        "Route input identity conflict; read the saved route status.",
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
