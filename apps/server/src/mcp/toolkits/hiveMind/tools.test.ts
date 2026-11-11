import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Context from "effect/Context";
import { ConversationsToolkit } from "../conversations/tools.ts";
import { HiveMindToolkit } from "./tools.ts";
const decodeToolSchema = Schema.decodeUnknownSync(McpSchema.ToolJsonSchema);

describe("Hive Mind wire discovery", () => {
  it("marks recall and conversation reads read-only while writes retain approval", () => {
    for (const name of ["hive_mind_recall", "hive_mind_status"] as const) {
      expect(Context.get(HiveMindToolkit.tools[name].annotations, Tool.Readonly)).toBe(true);
    }
    for (const tool of Object.values(ConversationsToolkit.tools)) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
    }
    for (const name of [
      "hive_mind_remember",
      "hive_mind_forget",
      "hive_mind_continuity",
      "hive_mind_sync",
    ] as const) {
      expect(Context.get(HiveMindToolkit.tools[name].annotations, Tool.Readonly)).toBe(false);
    }
    expect(Context.get(HiveMindToolkit.tools.hive_mind_forget.annotations, Tool.Destructive)).toBe(
      true,
    );
  });
  it("publishes MCP-compatible object schemas for all unified operations", () => {
    for (const tool of Object.values(HiveMindToolkit.tools)) {
      for (const schema of [tool.parametersSchema, tool.successSchema]) {
        expect(() => decodeToolSchema(Tool.getJsonSchemaFromSchema(schema))).not.toThrow();
      }
    }
  });
});
