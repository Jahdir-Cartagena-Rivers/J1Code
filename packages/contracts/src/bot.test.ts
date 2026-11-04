import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { BotProfiles } from "./bot.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeProfiles = Schema.decodeUnknownSync(BotProfiles);

const bot = {
  id: "garden-helper",
  name: "Garden helper",
  description: "Track garden work",
  instructions: "Use the supplied garden records.",
  projectId: "garden",
  modelSelection: { provider: "codex", model: "gpt-5" },
  pinned: false,
  archived: false,
  createdAt: "2026-11-04T00:00:00Z",
  updatedAt: "2026-11-04T00:00:00Z",
};

describe("persisted bot profiles", () => {
  it("preserves optional pinning and archived profiles through settings encoding", () => {
    const settings = decodeSettings({ bots: { [bot.id]: bot } });
    const encoded = encodeSettings(settings);
    expect(decodeSettings(encoded).bots).toEqual(settings.bots);
    expect(Object.values(settings.bots)[0]?.pinned).toBe(false);
    expect(decodePatch({ bots: { [bot.id]: null } }).bots).toEqual({ [bot.id]: null });
  });

  it("keeps older settings valid with no bots", () => {
    expect(decodeSettings({}).bots).toEqual({});
  });

  it("rejects ambiguous identities and excessive instruction payloads", () => {
    const decode = decodeProfiles;
    expect(() => decode({ different: bot })).toThrow();
    expect(() => decode({ [bot.id]: { ...bot, instructions: "x".repeat(32_001) } })).toThrow();
    expect(() => decode({ [bot.id]: { ...bot, name: " " } })).toThrow();
  });
});
