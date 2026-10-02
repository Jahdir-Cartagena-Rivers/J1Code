// @effect-diagnostics nodeBuiltinImport:off - resolves the existing environment-owned Hive Mind store.
import * as NodePath from "node:path";
import { DotIntegrationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import {
  forgetHiveFact,
  recallHiveFacts,
  rememberHiveFact,
  type HiveMemory,
} from "../hiveMind/store.ts";
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
  const config = yield* ServerConfig;
  const connections = yield* DotConnections;
  const filePath = NodePath.join(config.stateDir, "hive-mind.json");
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
  const store = <T>(run: () => Promise<T>) =>
    Effect.tryPromise({
      try: run,
      catch: () =>
        new DotIntegrationError({
          message: "Could not complete the Hive Mind operation. Existing memories are preserved.",
        }),
    });
  return {
    recall: Effect.fn("DotHiveMind.recall")(function* (input: {
      query: string;
      project?: string | undefined;
    }) {
      yield* authorize("read");
      return {
        memories: [...(yield* store(() => recallHiveFacts(filePath, input.query, input.project)))],
      };
    }),
    remember: Effect.fn("DotHiveMind.remember")(function* (
      input: Pick<HiveMemory, "scope" | "subject" | "fact"> & { project?: string | undefined },
    ) {
      const connection = yield* authorize("write");
      return {
        memory: yield* store(() =>
          rememberHiveFact(filePath, {
            ...input,
            project: input.project ?? null,
            sourceThreadId: `j1-dot:${connection.id}`,
          }),
        ),
      };
    }),
    forget: Effect.fn("DotHiveMind.forget")(function* ({ id }: { id: string }) {
      yield* authorize("write");
      return { removed: yield* store(() => forgetHiveFact(filePath, id)) };
    }),
  };
});

export class DotHiveMind extends Context.Service<DotHiveMind, Effect.Success<typeof make>>()(
  "t3/dot/DotHiveMind",
) {}
export const layer = Layer.effect(DotHiveMind, make);
