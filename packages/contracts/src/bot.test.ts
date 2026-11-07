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

  it("round trips a custom icon and accepts existing profiles without one", () => {
    const custom = decodeSettings({
      bots: { [bot.id]: { ...bot, icon: "🌱", voiceURI: "local-voice-id", voiceAutoPlay: true } },
    });
    expect(decodeSettings(encodeSettings(custom)).bots[bot.id]?.icon).toBe("🌱");
    expect(decodeSettings(encodeSettings(custom)).bots[bot.id]?.voiceURI).toBe("local-voice-id");
    expect(decodeSettings(encodeSettings(custom)).bots[bot.id]?.voiceAutoPlay).toBe(true);
    expect(decodeSettings({ bots: { [bot.id]: bot } }).bots[bot.id]?.icon).toBeUndefined();
    expect(() => decodeProfiles({ [bot.id]: { ...bot, icon: "x".repeat(17) } })).toThrow();
  });

  it("preserves standalone and existing project-linked bot profiles", () => {
    const settings = decodeSettings({ bots: { [bot.id]: { ...bot, projectId: null } } });
    expect(decodeSettings(encodeSettings(settings)).bots[bot.id]?.projectId).toBeNull();
    expect(decodeSettings({ bots: { [bot.id]: bot } }).bots[bot.id]?.projectId).toBe("garden");
  });

  it("persists bot routines and rejects duplicate identities", () => {
    const routine = {
      id: "water",
      name: "Water check",
      prompt: "Check the garden",
      enabled: true,
      schedule: { type: "interval", anchorAt: "2026-01-01T00:00:00Z", everyMinutes: 60 },
    };
    const settings = decodeSettings({ bots: { [bot.id]: { ...bot, routines: [routine] } } });
    expect(decodeSettings(encodeSettings(settings)).bots[bot.id]?.routines).toEqual([routine]);
    expect(() => decodeProfiles({ [bot.id]: { ...bot, routines: [routine, routine] } })).toThrow();
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
