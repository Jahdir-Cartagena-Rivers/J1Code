import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const parameters = Schema.Struct({
  name: Schema.String,
  arguments: Schema.Unknown,
});
export const BotToolkit = Toolkit.make(
  Tool.make("bot_tools", {
    description:
      "List this bot turn's selected tools, including team, routine and connected-app tools. The result includes each tool's input schema. These tools retain the bot's existing scopes and approval rules.",
    parameters: Schema.Struct({ query: Schema.optional(Schema.String) }),
    success: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          inputSchema: Schema.Unknown,
        }),
      ),
    }),
    failure: Schema.String,
    dependencies: [McpInvocationContext],
  }),
  Tool.make("bot_call", {
    description:
      "Run a tool returned by bot_tools with its exact name and arguments. Uses this bot turn's own tool connection; required approvals appear in the bot conversation.",
    parameters,
    success: Schema.Struct({ result: Schema.Unknown }),
    failure: Schema.String,
    dependencies: [McpInvocationContext],
  }),
);
