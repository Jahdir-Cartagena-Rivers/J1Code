// @effect-diagnostics nodeBuiltinImport:off - a throwaway local HTTP service for tests.
// @effect-diagnostics globalDate:off - fixture timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

interface FakeMemory {
  id: string;
  scope: "general" | "project";
  project: string | null;
  subject: string;
  fact: string;
  sourceThreadId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A minimal stand-in for the Hive Mind app: same routes and reply shapes, in memory.
 * It also writes the connection file J1 Code discovers, so tests exercise the real connector.
 */
export async function startFakeHiveMind() {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const memories = new Map<string, FakeMemory>();
  const contextRequests: Array<{ query: string; projects: ReadonlyArray<string> }> = [];
  const terms = (text: string) => text.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? [];
  const matches = (memory: FakeMemory, query: string) => {
    const haystack = `${memory.subject} ${memory.fact}`.toLowerCase();
    return (
      haystack.includes(query.toLowerCase()) || terms(query).every((t) => haystack.includes(t))
    );
  };
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "no" });
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const status = {
        records: memories.size,
        skills: 0,
        pendingIndex: 0,
        phase: "idle",
        lastSync: null,
        issues: [],
      };
      switch (request.url) {
        case "/v1/status":
        case "/v1/sync":
          return reply(200, status);
        case "/v1/search":
          return reply(200, {
            memories: [...memories.values()].filter((memory) => matches(memory, body.query)),
            retrieval: { status: "local" },
          });
        case "/v1/remember": {
          const project = body.scope === "project" ? (body.project ?? null) : null;
          const existing = [...memories.values()].find(
            (memory) =>
              memory.scope === body.scope &&
              memory.project === project &&
              memory.subject === body.subject,
          );
          const now = new Date().toISOString();
          const memory: FakeMemory = {
            id: existing?.id ?? NodeCrypto.randomUUID(),
            scope: body.scope,
            project,
            subject: body.subject,
            fact: body.fact,
            sourceThreadId: body.sourceThreadId ?? "hive-mind-api",
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          memories.set(memory.id, memory);
          return reply(200, { memory });
        }
        case "/v1/forget":
          return reply(200, { removed: memories.delete(body.id) });
        case "/v1/context": {
          contextRequests.push({ query: body.query, projects: body.projects });
          const wanted = terms(body.query);
          const notes = [...memories.values()].filter(
            (memory) =>
              wanted.length > 0 &&
              (memory.scope === "general" || body.projects.includes(memory.project)) &&
              wanted.some((t) => `${memory.subject} ${memory.fact}`.toLowerCase().includes(t)),
          );
          return reply(200, {
            context: notes.length
              ? `Hive Mind reference notes (fixture):\n${notes.map((n) => `- ${n.subject}: ${n.fact}`).join("\n")}`
              : "",
          });
        }
        default:
          return reply(404, { error: "unknown" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-fake-hive-"));
  const file = NodePath.join(directory, "connection.json");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await NodeFSP.writeFile(file, JSON.stringify({ origin, token }));
  const previous = process.env["HIVE_MIND_CONNECTION_FILE"];
  process.env["HIVE_MIND_CONNECTION_FILE"] = file;
  return {
    memories,
    contextRequests,
    /** Seed a record directly, as if saved earlier through the app. */
    seed: (memory: Pick<FakeMemory, "scope" | "project" | "subject" | "fact">) => {
      const now = new Date().toISOString();
      const id = NodeCrypto.randomUUID();
      memories.set(id, {
        id,
        sourceThreadId: "fixture",
        createdAt: now,
        updatedAt: now,
        ...memory,
      });
    },
    async close() {
      if (previous === undefined) delete process.env["HIVE_MIND_CONNECTION_FILE"];
      else process.env["HIVE_MIND_CONNECTION_FILE"] = previous;
      await new Promise((resolve) => server.close(resolve));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}
