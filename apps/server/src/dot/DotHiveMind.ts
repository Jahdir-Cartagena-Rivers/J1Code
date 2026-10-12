import { DotIntegrationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { forgetHiveMind, recallHiveMind, rememberHiveMind } from "../hiveMind/connector.ts";
import { DotInvocation } from "./DotService.ts";
import { connectionAllowsDotScope, DotConnections } from "./DotConnections.ts";

export function memoryScopeForTool(name: string) {
  switch (name) {
    case "hive_mind_recall":
      return "dot:memory:read" as const;
    case "hive_mind_remember":
    case "hive_mind_forget":
      return "dot:memory:write" as const;
    default:
      return null;
  }
}

export const make = Effect.gen(function* () {
  const connections = yield* DotConnections;
  const authorize = Effect.fn("DotHiveMind.authorize")(function* (operation: "read" | "write") {
    const invocation = yield* DotInvocation;
    const connection = yield* connections.getActive(invocation.connectionId);
    const scope = operation === "read" ? "dot:memory:read" : "dot:memory:write";
    if (
      !connectionAllowsDotScope(connection, scope) ||
      (invocation.scopes && !invocation.scopes.includes(scope))
    )
      return yield* new DotIntegrationError({
        message: "This Dot connection has no Hive Mind permission for this operation.",
      });
    return connection;
  });
  const failed = () =>
    new DotIntegrationError({
      message: "Could not complete the Hive Mind operation. Existing memories are preserved.",
    });
  return {
    recall: Effect.fn("DotHiveMind.recall")(function* (input: {
      query: string;
      project?: string | undefined;
    }) {
      yield* authorize("read");
      return yield* recallHiveMind(input.query, input.project).pipe(Effect.mapError(failed));
    }),
    remember: Effect.fn("DotHiveMind.remember")(function* (input: {
      scope: "general" | "project";
      subject: string;
      fact: string;
      project?: string | undefined;
    }) {
      const connection = yield* authorize("write");
      return yield* rememberHiveMind({
        ...input,
        sourceThreadId: `j1-dot:${connection.id}`,
      }).pipe(Effect.mapError(failed));
    }),
    forget: Effect.fn("DotHiveMind.forget")(function* ({ id }: { id: string }) {
      yield* authorize("write");
      return yield* forgetHiveMind(id).pipe(Effect.mapError(failed));
    }),
  };
});

export class DotHiveMind extends Context.Service<DotHiveMind, Effect.Success<typeof make>>()(
  "t3/dot/DotHiveMind",
) {}
export const layer = Layer.effect(DotHiveMind, make);
