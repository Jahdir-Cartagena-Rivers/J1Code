import * as Effect from "effect/Effect";
import { AgentDelegation } from "../../AgentDelegation.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { AgentsToolkit } from "./tools.ts";

export const AgentsToolkitHandlersLive = AgentsToolkit.toLayer(
  Effect.gen(function* () {
    const agents = yield* AgentDelegation;
    return AgentsToolkit.of({
      list_agent_models: () =>
        McpInvocationContext.pipe(Effect.flatMap((scope) => agents.models(scope))),
      spawn_agent: (input) =>
        McpInvocationContext.pipe(Effect.flatMap((scope) => agents.spawn(input, scope))),
      get_agent_result: ({ threadId }) =>
        McpInvocationContext.pipe(Effect.flatMap((scope) => agents.get(threadId, scope))),
      list_agents: () =>
        McpInvocationContext.pipe(
          Effect.flatMap((scope) => agents.list(scope)),
          Effect.map((agents) => ({ agents })),
        ),
      wait_agent: ({ threadId, timeoutSeconds }) =>
        McpInvocationContext.pipe(
          Effect.flatMap((scope) => agents.wait(threadId, timeoutSeconds ?? 30, scope)),
        ),
      cancel_agent: ({ threadId }) =>
        McpInvocationContext.pipe(Effect.flatMap((scope) => agents.cancel(threadId, scope))),
    });
  }),
);
