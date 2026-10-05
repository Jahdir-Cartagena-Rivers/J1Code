import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import * as Tool from "effect/unstable/ai/Tool";
import { HiveMindToolkit } from "./tools.ts";
const decodeToolSchema = Schema.decodeUnknownSync(McpSchema.ToolJsonSchema);

describe("Hive Mind wire discovery", () => {
  it("publishes MCP-compatible object schemas for all unified operations", () => {
    for (const tool of Object.values(HiveMindToolkit.tools)) {
      for (const schema of [tool.parametersSchema, tool.successSchema]) {
        expect(() => decodeToolSchema(Tool.getJsonSchemaFromSchema(schema))).not.toThrow();
      }
    }
  });
});
