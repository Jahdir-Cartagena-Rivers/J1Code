import { describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import * as Context from "effect/Context";
import { ConversationsToolkit } from "../conversations/tools.ts";
import { HiveMindToolkit } from "./tools.ts";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";

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
      expect(advertisedJsonSchema(tool)).toMatchObject({ type: "object" });
      expect(Tool.getJsonSchema(tool.setParameters(tool.successSchema))).toMatchObject({ type: "object" });
    }
  });
});
