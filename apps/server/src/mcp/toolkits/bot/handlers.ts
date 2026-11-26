import * as Effect from "effect/Effect";
import { botExecutionContext } from "../../../mausbot/ExecutionContext.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { BotToolkit } from "./tools.ts";

const context = McpInvocationContext.pipe(
  Effect.flatMap((scope) => {
    const value = scope.thread === undefined
      ? undefined
      : botExecutionContext(scope.thread.threadId, scope.thread.providerSessionId);
    return value ? Effect.succeed(value) : Effect.fail("No bot tools are active for this session.");
  }),
  Effect.mapError(() => "No bot tools are active for this session."),
);

export const BotToolkitHandlers = BotToolkit.toLayer(
  Effect.succeed(
    BotToolkit.of({
      bot_tools: ({ query }) =>
        context.pipe(
          Effect.map((value) => ({
            tools: query?.trim()
              ? value.tools.filter((tool) =>
                  `${tool.name} ${tool.description ?? ""}`
                    .toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase()),
                )
              : value.tools,
          })),
        ),
      bot_call: (input) =>
        context.pipe(
          Effect.flatMap((value) =>
            value.tools.some((tool) => tool.name === input.name)
              ? Effect.tryPromise({
                  try: async (signal) => ({
                    result: await value.call(input.name, input.arguments, signal),
                  }),
                  catch: () => "The bot tool call failed or its turn ended.",
                })
              : Effect.fail("This tool is not selected for the bot turn."),
          ),
        ),
    }),
  ),
);
