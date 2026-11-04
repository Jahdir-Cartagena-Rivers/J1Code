import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { resolveRoute, type RouteEndpoint, type RouteState } from "./routeState.ts";

type Stored = { readonly revision: number; readonly state: RouteState };
const same = (a: RouteEndpoint, b: RouteEndpoint) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId;

export interface ManualRoutePorts {
  readonly environmentId: string;
  /** Revalidate session revocation/expiry; never return a session decoded from RPC arguments. */
  readonly authenticate: () => Promise<AuthenticatedSession>;
  readonly get: (id: string) => Promise<Stored | null>;
  readonly list?: (source: RouteEndpoint) => Promise<readonly string[]>;
  readonly suggest?: (source: RouteEndpoint, request: string) => Promise<RouteEndpoint | null>;
  /** Exact environment/project/thread lookup, including current availability and access. */
  readonly inspect: (
    session: AuthenticatedSession,
    endpoint: RouteEndpoint,
  ) => Promise<{
    readonly endpoint: RouteEndpoint;
    readonly permissions: readonly string[] | null;
  } | null>;
  /** Atomic revision CAS. Must persist before waking the drain; never retry the callback blindly. */
  readonly commit: (id: string, revision: number, state: RouteState) => Promise<Stored>;
}

/** Construct per authenticated UI connection only. Do not expose prepare/confirm through MCP.
 * The UI calls prepare and confirm only when the user approves the exact proposed destination. Authentication alone cannot prove physical human interaction.
 * Tokens are connection-local, expire after one minute and are consumed even on failed attempts.
 * Restart/reconnect requires a new user action; durable revision CAS prevents double confirmation.
 */
export function makeManualRouteBoundary(ports: ManualRoutePorts) {
  const actions = new Map<
    string,
    {
      sessionId: string;
      subject: string;
      source: RouteEndpoint;
      destination: RouteEndpoint;
      requestId: string;
      revision: number;
      fingerprint: string;
      expires: number;
    }
  >();
  const authorize = async (write: boolean) => {
    const session = await ports.authenticate();
    if (
      !session.subject.trim() ||
      !session.scopes.includes(write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope)
    )
      throw new Error("Unauthorized route action");
    return session;
  };
  const load = async (id: string, source: RouteEndpoint, session: AuthenticatedSession) => {
    if (source.environmentId !== ports.environmentId)
      throw new Error("Source environment mismatch");
    const actual = await ports.inspect(session, source);
    if (!actual || !same(actual.endpoint, source)) throw new Error("Source unavailable");
    const stored = await ports.get(id);
    if (!stored || !same(stored.state.originalRequest.source, source))
      throw new Error("Route source mismatch");
    return stored;
  };
  return {
    list: async (source: RouteEndpoint) => {
      const session = await authorize(false);
      if (source.environmentId !== ports.environmentId)
        throw new Error("Source environment mismatch");
      const actual = await ports.inspect(session, source);
      if (!actual || !same(actual.endpoint, source)) throw new Error("Source unavailable");
      const ids = ports.list ? await ports.list(source) : [];
      const rows = await Promise.all(
        ids.map(async (id) => {
          const stored = await load(id, source, session);
          const state = stored.state;
          const seen = (kind: string) => state.receipts.some((receipt) => receipt.kind === kind);
          return {
            summary: state.originalRequest.content.slice(0, 200),
            requestId: id,
            revision: stored.revision,
            status: state.status,
            reason: state.reason,
            destination:
              state.request.destination ??
              (state.status === "suggested" && ports.suggest
                ? await ports.suggest(source, state.originalRequest.content)
                : null),
            delivered: seen("delivered"),
            accepted: seen("accepted"),
            completed: seen("completed"),
            failed: seen("failed"),
            uncertain: state.status === "uncertain",
          };
        }),
      );
      return rows;
    },
    prepare: async (id: string, source: RouteEndpoint, destination: RouteEndpoint) => {
      const session = await authorize(true);
      const stored = await load(id, source, session);
      if (stored.state.status !== "suggested")
        throw new Error("Route is not awaiting confirmation");
      const actual = await ports.inspect(session, destination);
      if (!actual || !same(actual.endpoint, destination))
        throw new Error("Destination unavailable");
      // Only one outstanding action per connection; a new selection invalidates the old one.
      actions.clear();
      const token = NodeCrypto.randomUUID();
      actions.set(token, {
        sessionId: session.sessionId,
        subject: session.subject,
        source: structuredClone(source),
        destination: structuredClone(destination),
        requestId: id,
        revision: stored.revision,
        fingerprint: stored.state.fingerprint,
        expires: (await Effect.runPromise(Clock.currentTimeMillis)) + 60_000,
      });
      return { token, revision: stored.revision, destination: structuredClone(destination) };
    },
    confirm: async (token: string) => {
      const action = actions.get(token);
      actions.delete(token);
      if (!action || action.expires <= (await Effect.runPromise(Clock.currentTimeMillis)))
        throw new Error("Invalid or consumed user action");
      const session = await authorize(true);
      if (session.sessionId !== action.sessionId || session.subject !== action.subject)
        throw new Error("User action session mismatch");
      const stored = await load(action.requestId, action.source, session);
      if (stored.revision !== action.revision || stored.state.fingerprint !== action.fingerprint)
        throw new Error("Stale user action");
      const source = await ports.inspect(session, action.source);
      const destination = await ports.inspect(session, action.destination);
      if (
        !source?.permissions ||
        !same(source.endpoint, action.source) ||
        !destination?.permissions ||
        !same(destination.endpoint, action.destination)
      )
        throw new Error("Destination or effective permissions unavailable");
      if (destination.permissions.some((p) => !source.permissions?.includes(p)))
        throw new Error("Current source permission ceiling exceeded");
      const state = resolveRoute(stored.state, {
        authenticatedUser: true,
        userId: session.subject,
        source: action.source,
        destination: action.destination,
        destinationPermissions: destination.permissions,
      });
      return ports.commit(action.requestId, action.revision, state);
    },
    status: async (id: string, source: RouteEndpoint) => {
      const stored = await load(id, source, await authorize(false));
      const { state } = stored;
      const seen = (kind: "delivered" | "accepted" | "completed" | "failed") =>
        state.receipts.some((receipt) => receipt.kind === kind);
      return {
        requestId: id,
        revision: stored.revision,
        status: state.status,
        reason: state.reason,
        destination: state.request.destination,
        delivered: seen("delivered"),
        accepted: seen("accepted"),
        completed: seen("completed"),
        failed: seen("failed"),
        uncertain: state.status === "uncertain",
      };
    },
  };
}
