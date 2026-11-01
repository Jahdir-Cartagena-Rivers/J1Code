import type { ChatRoutingMode, OrchestrationThreadShell } from "@t3tools/contracts";
import { Effect } from "effect";
import type { RoutingPorts } from "../mcp/toolkits/routing/boundary.ts";
import { DeliveryDispatchError, type DeliveryEndpointState } from "./deliveryDispatcher.ts";
import type { RouteEndpoint } from "./routeState.ts";

type Shell = Pick<
  OrchestrationThreadShell,
  "id" | "projectId" | "archivedAt" | "session" | "hasPendingApprovals" | "hasPendingUserInput"
>;

export interface SnapshotRoutingFacts {
  readonly environmentId: string;
  /** Adapt ProjectionSnapshotQuery.getThreadShellById; absence also covers deleted threads. */
  readonly thread: (threadId: string) => Effect.Effect<Shell | null, string>;
  /** Read current ServerSettings.chatRoutingMode, never a tool argument. */
  readonly settings: () => Effect.Effect<{ readonly chatRoutingMode: ChatRoutingMode }, string>;
  /** Verified effective capabilities. Unknown is null, never an empty capability set.
   * Runtime/provider labels alone do not establish an execution permission ceiling. */
  readonly permissions: (
    endpoint: RouteEndpoint,
  ) => Effect.Effect<readonly string[] | null, string>;
}

/** Read-only preflight adapter. Does not reserve admission, persist routes or start workers.
 * Caller must supply atomic permission/admission revalidation at delivery. Snapshots contain
 * no authoritative task binding, route ancestry or authenticated manual-action evidence. */
export function makeSnapshotRoutingAdapter(facts: SnapshotRoutingFacts) {
  const lookup = Effect.fn("SnapshotRouting.lookup")(function* (
    environmentId: string,
    threadId: string,
  ) {
    if (environmentId !== facts.environmentId) return null;
    const shell = yield* facts.thread(threadId);
    return shell && shell.id === threadId && shell.archivedAt === null ? shell : null;
  });
  const current: RoutingPorts["current"] = Effect.fn("SnapshotRouting.current")(
    function* (environmentId, threadId) {
      const shell = yield* lookup(environmentId, threadId);
      return shell ? { environmentId, threadId, projectId: shell.projectId } : null;
    },
  );
  const policy: RoutingPorts["policy"] = Effect.fn("SnapshotRouting.policy")(function* (source) {
    const actual = yield* current(source.environmentId, source.threadId);
    if (!actual || actual.projectId !== source.projectId)
      return yield* Effect.fail("Source unavailable.");
    const settings = yield* facts.settings();
    // No trusted ancestry service yet: one hop only. Never infer a manual user action.
    return { mode: settings.chatRoutingMode, manual: false, visited: [], maxHops: 1 };
  });
  const owner: RoutingPorts["owner"] = Effect.fn("SnapshotRouting.owner")(
    function* (_source, _taskId, candidate) {
      if (!candidate) return { destination: null, ambiguous: true };
      const actual = yield* current(candidate.environmentId, candidate.threadId);
      if (!actual || actual.projectId !== candidate.projectId)
        return { destination: null, ambiguous: true };
      // A model-supplied candidate is a suggestion, never current task ownership evidence.
      return { destination: actual, ambiguous: true };
    },
  );
  const inspect = Effect.fn("SnapshotRouting.inspect")(function* (
    endpoint: RouteEndpoint,
  ): Effect.fn.Return<DeliveryEndpointState, string> {
    const shell = yield* lookup(endpoint.environmentId, endpoint.threadId);
    if (!shell || shell.projectId !== endpoint.projectId)
      return yield* Effect.fail("Endpoint unavailable.");
    const permissions = yield* facts.permissions(endpoint);
    if (permissions === null) return yield* Effect.fail("Effective permissions unavailable.");
    const status =
      shell.hasPendingApprovals || shell.hasPendingUserInput
        ? "approval-pending"
        : shell.session?.activeTurnId != null ||
            shell.session?.status === "running" ||
            shell.session?.status === "starting"
          ? "busy"
          : "ready";
    return { permissions: [...permissions], status };
  });
  return {
    current,
    policy,
    owner,
    inspect: (endpoint: RouteEndpoint) =>
      inspect(endpoint).pipe(Effect.mapError((message) => new DeliveryDispatchError({ message }))),
  };
}
