// @effect-diagnostics nodeBuiltinImport:off - isolated disk receipts and a fake selected Hive transport.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { MausbotHiveMemory } from "./HiveMemory.ts";
import type { HiveMindMemory } from "@t3tools/contracts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-assistant-hive-"));
  const records = new Map<string, HiveMindMemory>();
  const calls: string[] = [];
  let available = true;
  let searchExtra: HiveMindMemory[] = [];
  const memory = new MausbotHiveMemory({
    file: NodePath.join(root, "hive.json"),
    indexDir: root,
    connection: async () =>
      available ? { origin: "https://hive.example", token: "private-test-credential" } : null,
    request: async (_connection, route, value) => {
      calls.push(route);
      if (route === "/v1/status") return {};
      if (route === "/v1/remember") {
        const fact = value as Omit<HiveMindMemory, "id" | "createdAt" | "updatedAt">;
        const id = `${fact.project}/${fact.subject}`;
        const row = { ...fact, id, createdAt: "2026-11-07", updatedAt: "2026-11-07" };
        records.set(id, row);
        return { memory: row };
      }
      if (route === "/v1/forget") return { removed: records.delete((value as { id: string }).id) };
      if (route === "/v1/search")
        return { memories: [...searchExtra, ...records.values()], retrieval: { status: "ready" } };
      throw new Error("Unexpected route");
    },
  });
  const recall = (text: string, query = "late note") =>
    memory.handle({
      action: "recall",
      botId: "memo",
      threadId: "thread-one",
      query,
      documents: [{ path: "MEMORY.md", text }],
    });
  return {
    root,
    records,
    calls,
    memory,
    recall,
    offline: () => {
      available = false;
    },
    extras: (rows: HiveMindMemory[]) => {
      searchExtra = rows;
    },
  };
}

describe("assistant Hive Mind extension", () => {
  it("indexes full notes beyond the always-loaded prefix, retrieves bounded passages and reuses unchanged receipts", async () => {
    const f = await fixture();
    try {
      const text = `${"Saved preference\n".repeat(220)}\nLATE_NOTE_OUTSIDE_PREFIX`;
      const result = await f.recall(text);
      expect(JSON.stringify(result)).toContain("LATE_NOTE_OUTSIDE_PREFIX");
      expect([...f.records.values()].map((item) => item.fact).join("")).toBe(text);
      const writes = f.calls.filter((route) => route === "/v1/remember").length;
      await f.recall(text);
      expect(f.calls.filter((route) => route === "/v1/remember")).toHaveLength(writes);
      expect(f.calls.every((route) => ["/v1/remember", "/v1/search"].includes(route))).toBe(true);
      const large = await f.recall("a".repeat(40_000));
      expect((large as { context: string }).context.length).toBeLessThan(13_000);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("filters foreign scopes and stale remote revisions even when search returns them", async () => {
    const f = await fixture();
    try {
      await f.recall("CURRENT_NOTE");
      const owned = [...f.records.values()][0]!;
      f.extras([
        { ...owned, fact: "STALE_NOTE" },
        { ...owned, id: "foreign", project: "j1-assistant:other", fact: "PRIVATE_OTHER_BOT" },
        { ...owned, scope: "general", project: null, fact: "UNSELECTED_GENERAL_NOTE" },
      ]);
      const result = JSON.stringify(await f.recall("CURRENT_NOTE"));
      expect(result).toContain("CURRENT_NOTE");
      expect(result).not.toMatch(/STALE_NOTE|PRIVATE_OTHER_BOT|UNSELECTED_GENERAL_NOTE/);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("updates changed passages and forgets removed owned chunks without deleting another assistant's notes", async () => {
    const f = await fixture();
    try {
      await f.recall("old".repeat(4000));
      await f.memory.handle({
        action: "recall",
        botId: "other",
        threadId: "other-thread",
        query: "",
        documents: [{ path: "MEMORY.md", text: "OTHER" }],
      });
      await f.recall("NEW");
      expect([...f.records.values()].map((row) => row.fact).sort()).toEqual(["NEW", "OTHER"]);
      expect(f.calls).toContain("/v1/forget");
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("requires selected external authority and preserves receipts during an outage", async () => {
    const f = await fixture();
    try {
      await f.recall("SAVED");
      const before = await NodeFSP.readFile(NodePath.join(f.root, "memo.json"), "utf8");
      const calls = f.calls.length;
      f.offline();
      expect(await f.memory.handle({ action: "status" })).toMatchObject({ available: false });
      await expect(f.recall("CHANGED")).rejects.toThrow("external Hive Mind");
      expect(f.calls).toHaveLength(calls);
      expect(await NodeFSP.readFile(NodePath.join(f.root, "memo.json"), "utf8")).toBe(before);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("rejects invalid paths, oversized snapshots and stopped requests before remote writes", async () => {
    const f = await fixture();
    try {
      const base = {
        action: "recall",
        botId: "memo",
        threadId: "thread",
        query: "",
        documents: [{ path: "../secret", text: "not notes" }],
      };
      await expect(f.memory.handle(base)).rejects.toThrow("Only local memory");
      await expect(f.recall("x".repeat(1024 * 1024 + 1))).rejects.toThrow("1 MiB");
      await expect(
        f.memory.handle({ ...base, documents: [{ path: "MEMORY.md", text: "NOTE" }] }, () => false),
      ).rejects.toThrow("stopped");
      expect(f.calls).toEqual([]);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("supports the original memory store's Unicode and spaced topic names", async () => {
    const f = await fixture();
    try {
      await f.memory.handle({
        action: "recall",
        botId: "memo",
        threadId: "thread",
        query: "",
        documents: [{ path: "memory/旅行 notes.md", text: "TOPIC_NOTE" }],
      });
      expect([...f.records.values()][0]?.fact).toBe("TOPIC_NOTE");
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("preserves malformed or future receipts instead of resetting and deleting data", async () => {
    const f = await fixture();
    try {
      const file = NodePath.join(f.root, "memo.json");
      await NodeFSP.writeFile(file, '{"future":true}');
      await expect(f.recall("NOTE")).rejects.toThrow();
      expect(await NodeFSP.readFile(file, "utf8")).toBe('{"future":true}');
      expect(f.calls).toEqual([]);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("retains acknowledged chunks after cancellation so retry does not repeat completed writes", async () => {
    const f = await fixture();
    try {
      const text = "note".repeat(2500);
      await expect(
        f.memory.handle(
          {
            action: "recall",
            botId: "memo",
            threadId: "thread",
            query: "",
            documents: [{ path: "MEMORY.md", text }],
          },
          () => !f.calls.includes("/v1/remember"),
        ),
      ).rejects.toThrow("stopped");
      expect(f.records.size).toBe(1);
      await f.recall(text);
      expect(f.calls.filter((route) => route === "/v1/remember")).toHaveLength(3);
      expect([...f.records.values()].map((row) => row.fact).join("")).toBe(text);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("keeps provenance valid for the external API when original conversation identifiers are long", async () => {
    const f = await fixture();
    try {
      await f.memory.handle({
        action: "recall",
        botId: "b".repeat(128),
        threadId: "t".repeat(128),
        query: "",
        documents: [{ path: "MEMORY.md", text: "NOTE" }],
      });
      expect([...f.records.values()][0]!.sourceThreadId).toMatch(/^mausbot:[a-f0-9]{64}$/);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
});
