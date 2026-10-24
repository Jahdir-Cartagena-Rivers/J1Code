// @effect-diagnostics nodeBuiltinImport:off - isolated service boundary fixtures.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  selectedHiveConnection,
  rememberSelectedHive,
  recallSelectedHive,
  selectedHiveContext,
  externalHiveSnapshot,
  materializeHiveImage,
  captureHiveEvent,
  bindHiveTask,
} from "./backend.ts";
import { HiveMindRuntime } from "./runtime.ts";
import { hivePaths } from "./config.ts";
import { readHiveMind } from "./store.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const fact = {
  scope: "project" as const,
  project: "Studio",
  subject: "Lamp shape",
  fact: "Use curved proportions",
  sourceThreadId: "chat-a",
};
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "j1-backend-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "hive-mind.json");
  const connectionFile = path.join(directory, "connection.json");
  const configure = (external: boolean) =>
    fs.writeFile(
      hivePaths(file).config,
      JSON.stringify({
        version: 1,
        automatic: false,
        backend: external ? { mode: "external", connectionFile } : { mode: "builtin" },
      }),
    );
  return { file, directory, connectionFile, configure };
}
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0XcAAAAASUVORK5CYII=",
  "base64",
);

describe("selected Hive Mind backend", () => {
  it("keeps built-in as default without requiring a standalone app", async () => {
    const f = await fixture();
    expect(await selectedHiveConnection(f.file)).toBeNull();
    await rememberSelectedHive(f.file, fact);
    expect((await recallSelectedHive(f.file, "Lamp", "Studio")).memories[0]?.fact).toBe(fact.fact);
    expect(
      (await selectedHiveContext(f.file, "Lamp shape", ["Studio"], "chat-b")).context,
    ).toContain(fact.fact);
    expect((await readHiveMind(f.file)).memories).toHaveLength(1);
  });
  it("routes tools and pre-turn context to external authority, materializes images, and restores local mode without migration", async () => {
    const f = await fixture();
    const local = await rememberSelectedHive(f.file, { ...fact, fact: "Local original" });
    const original = await fs.readFile(f.file, "utf8");
    const token = randomBytes(32).toString("hex");
    const received: Array<{ route: string; body: unknown }> = [];
    const saved: Array<typeof local> = [];
    const server = http.createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      received.push({ route: request.url ?? "", body });
      const json = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      switch (request.url) {
        case "/v1/remember": {
          const record = { ...local, ...body, id: "external-memory" };
          saved.push(record);
          json({ memory: record });
          break;
        }
        case "/v1/search":
          json({ memories: saved, retrieval: { status: "ready" } });
          break;
        case "/v1/working-context":
          json({
            context: "External current correction",
            sequence: 12,
            usedIds: ["external-memory"],
            taskId: body.taskId ?? null,
            assets: [{ id: "reference", mime: "image/png", caption: "Reference" }],
          });
          break;
        case "/v1/status":
          json({
            config: { version: 1 },
            defaultVault: "",
            defaultBank: "",
            records: saved.length,
            skills: 0,
            pendingIndex: 0,
            phase: "idle",
            lastSync: null,
            issues: [],
          });
          break;
        case "/v1/brain":
          json({ records: [] });
          break;
        case "/v1/brain/save":
          json({
            id: "event",
            revision: "revision",
            scope: body.scope,
            project: body.project ?? null,
            data: body.data,
          });
          break;
        case "/v1/assets/reference":
          response.writeHead(200, { "content-type": "image/png", "content-length": pixel.length });
          response.end(pixel);
          break;
        default:
          response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    cleanups.push(async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    });
    await fs.writeFile(
      f.connectionFile,
      JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, token }),
    );
    await f.configure(true);
    await rememberSelectedHive(f.file, fact);
    expect((await recallSelectedHive(f.file, "Lamp")).memories[0]?.id).toBe("external-memory");
    const packet = await selectedHiveContext(f.file, "Continue", ["Studio"], "chat-b");
    expect(packet.context).toBe("External current correction");
    if (!packet.connection) throw new Error("Missing selected connection");
    const image = await materializeHiveImage(
      packet.connection,
      "reference",
      path.join(f.directory, "attachments"),
      "chat-b",
    );
    expect(await fs.readFile(image.path)).toEqual(pixel);
    expect(image.attachment.type).toBe("image");
    await captureHiveEvent(packet.connection, {
      eventId: "event-1",
      threadId: "chat-b",
      provider: "test",
      project: "Studio",
      summary: "api_key=do-not-retain",
    });
    expect(JSON.stringify(received)).not.toContain("do-not-retain");
    await bindHiveTask(f.file, "chat-b");
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    const runtime = new HiveMindRuntime(f.file);
    cleanups.push(() => runtime.close());
    expect((await runtime.snapshot()).records).toBe(1);
    await f.configure(false);
    expect((await recallSelectedHive(f.file, "Lamp")).memories[0]?.id).toBe(local.id);
  });
  it("reports external outages and keeps switch-back available without fallback writes", async () => {
    const f = await fixture();
    await rememberSelectedHive(f.file, fact);
    const original = await fs.readFile(f.file, "utf8");
    await f.configure(true);
    expect((await externalHiveSnapshot(f.file))?.phase).toBe("degraded");
    await expect(
      rememberSelectedHive(f.file, { ...fact, fact: "Must not land locally" }),
    ).rejects.toThrow(/connection is unavailable/);
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    await f.configure(false);
    expect((await recallSelectedHive(f.file, "Lamp")).memories[0]?.fact).toBe(fact.fact);
  });
});
