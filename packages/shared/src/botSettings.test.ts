import { BotId, BotProfile, DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const decodeProfile = Schema.decodeSync(BotProfile);
const profile = (id: string) =>
  decodeProfile({
    id: BotId.make(id),
    name: id,
    description: "",
    instructions: "Use supplied sources.",
    projectId: ProjectId.make("garden"),
    modelSelection: { instanceId: "codex", model: "fast", options: { reasoningEffort: "high" } },
    pinned: false,
    archived: false,
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
  });

describe("bot profile updates", () => {
  it("preserves independent profile changes and removes only the requested profile", () => {
    const first = profile("first"),
      second = profile("second");
    const a = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { bots: { [first.id]: first } });
    const b = applyServerSettingsPatch(a, { bots: { [second.id]: second } });
    const c = applyServerSettingsPatch(b, { bots: { [first.id]: null } });
    expect(Object.values(c.bots)).toEqual([second]);
  });

  it("replaces a profile completely so old model options do not survive a change", () => {
    const first = profile("first");
    const a = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { bots: { [first.id]: first } });
    const next = {
      ...first,
      instructions: "",
      modelSelection: { ...first.modelSelection, model: "different", options: undefined },
    };
    const b = applyServerSettingsPatch(a, { bots: { [first.id]: next } });
    expect(b.bots[first.id]?.instructions).toBe("");
    expect(b.bots[first.id]?.modelSelection.options).toBeUndefined();
    expect(a.bots[first.id]?.modelSelection.model).toBe("fast");
  });
});
