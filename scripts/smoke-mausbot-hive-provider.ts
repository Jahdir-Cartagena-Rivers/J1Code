// Isolated native bot MCP -> authenticated harness -> parent IPC -> selected Hive HTTP qualification.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeEvents from "node:events";
import { MausbotHiveMemory } from "../apps/server/src/mausbot/HiveMemory.ts";
import { resolveMausbotResources } from "../apps/server/src/mausbot/Resources.ts";
import { mausbotChildEnvironment } from "../apps/server/src/mausbot/ChildEnvironment.ts";

let assembly = NodePath.resolve(process.argv[2] ?? "");
NodeAssert.ok(
  process.argv[2],
  "Supply the prepared bundled OSS assembly or its runtime archive directory.",
);
const sandbox = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-provider-proof-"));
const archive = await NodeFSP.access(NodePath.join(assembly, "runtime.zip")).then(
  () => true,
  () => false,
);
if (archive)
  assembly = await resolveMausbotResources(assembly, NodePath.join(sandbox, "verified-runtime"));
const serverDir = NodePath.join(assembly, archive ? "server" : "dist-server");
const uiDir = NodePath.join(assembly, archive ? "ui" : "dist");
const records = new Map<string, Record<string, unknown>>();
let rejectHiveWrites = false;
const hiveToken = NodeCrypto.randomBytes(32).toString("hex");
const serve = async (server: NodeHttp.Server) => {
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  const address = server.address();
  NodeAssert.ok(address && typeof address !== "string");
  return address.port;
};
const hive = NodeHttp.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== `Bearer ${hiveToken}`) {
    res.writeHead(401);
    res.end("{}");
    return;
  }
  let text = "";
  for await (const part of req) text += part;
  const body = text ? JSON.parse(text) : {};
  if (req.url === "/v1/remember" && rejectHiveWrites) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Synthetic read-only connection" }));
    return;
  }
  if (req.url === "/v1/remember") {
    const memory = {
      ...body,
      project: body.project ?? null,
      id: NodeCrypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    records.set(memory.id, memory);
    res.end(JSON.stringify({ memory }));
  } else if (req.url === "/v1/search")
    res.end(
      JSON.stringify({
        memories: [...records.values()].filter((m) => String(m.fact).includes(body.query)),
        retrieval: { status: "ready" },
      }),
    );
  else {
    res.writeHead(404);
    res.end("{}");
  }
});
const hivePort = await serve(hive);
const portProbe = NodeHttp.createServer();
const port = await serve(portProbe);
await new Promise<void>((r) => portProbe.close(() => r()));
const webhookProbe = NodeHttp.createServer();
const webhookPort = await serve(webhookProbe);
await new Promise<void>((r) => webhookProbe.close(() => r()));
const data = NodePath.join(sandbox, "bot-state");
await NodeFSP.mkdir(data);
const connectionFile = NodePath.join(sandbox, "selected-connection.json");
await NodeFSP.writeFile(
  connectionFile,
  JSON.stringify({ origin: `http://127.0.0.1:${hivePort}`, token: hiveToken }),
);
await NodeFSP.writeFile(
  NodePath.join(sandbox, "hive-mind.config.json"),
  JSON.stringify({ version: 1, backend: { mode: "external", connectionFile } }),
);
const memory = new MausbotHiveMemory({
  file: NodePath.join(sandbox, "hive-mind.json"),
  indexDir: NodePath.join(sandbox, "note-index"),
});
const owner = NodeCrypto.randomBytes(32).toString("base64url"),
  testKey = NodeCrypto.randomBytes(32).toString("hex");
const child = NodeChildProcess.spawn(process.execPath, [NodePath.join(serverDir, "index.js")], {
  cwd: assembly,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe", "ipc"],
  env: {
    ...mausbotChildEnvironment(),
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(webhookPort),
    OMB_DATA_DIR: data,
    OMB_STATIC_DIR: uiDir,
    OMB_LOOPBACK_TRUST: "service",
    OMB_CLI_OWNER_STDIN: "1",
    OMB_TEST_INTERNAL_CAPABILITY_KEY: testKey,
    OMB_DESKTOP_PARENT: "0",
    J1_MAUSBOT_MANAGED: "1",
  },
});
const pending = new Map<string, { cancelled: boolean }>();
let requests = 0,
  stderr = "";
child.stderr!.on("data", (chunk) => {
  stderr = (stderr + String(chunk)).slice(-4000);
});
child.on("message", (value) => {
  const message = value as { type?: string; requestId: string; input?: unknown };
  if (message.type === "j1:hive-cancel") {
    const operation = pending.get(message.requestId);
    if (operation) operation.cancelled = true;
    return;
  }
  if (message.type !== "j1:hive-request") return;
  requests++;
  const operation = { cancelled: false };
  pending.set(message.requestId, operation);
  const current = () => child.connected && !operation.cancelled;
  void memory
    .handle(message.input, current)
    .then(
      (value) => {
        if (current()) child.send({ type: "j1:hive-result", requestId: message.requestId, value });
      },
      () => {
        if (current())
          child.send({
            type: "j1:hive-result",
            requestId: message.requestId,
            error: "Selected Hive unavailable",
          });
      },
    )
    .finally(() => pending.delete(message.requestId));
});
const origin = `http://127.0.0.1:${port}`;
let session = "";
const api = async (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await fetch(origin + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(session ? { authorization: `Bearer ${session}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};
let proxy: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Harness startup deadline: ${stderr}`)),
      45000,
    );
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-4000);
      if (output.includes(`openmausbot server on ${origin}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Harness exited: ${stderr}`));
    });
    child.stdin!.end(owner + "\n");
  });
  const paired = await api(
    "/api/auth/pairing",
    "POST",
    { label: "Synthetic Hive proof", scopes: ["admin", "client"] },
    { "x-openmausbot-cli-owner": owner },
  );
  NodeAssert.equal(paired.status, 200);
  const signed = await api("/api/auth/pair", "POST", {
    code: paired.body.code,
    label: "Synthetic Hive proof",
  });
  session = signed.body.token;
  NodeAssert.ok(session);
  const created = await api("/api/bots", "POST", { name: "Synthetic Hive fixture" });
  NodeAssert.equal(created.status, 201);
  const botId = created.body.bot.id,
    threadId = created.body.bot.threadId;
  const mint = async (kind = "agents") => {
    const result = await api(
      "/api/testing/internal-capability",
      "POST",
      { botId, threadId, kind },
      { "x-openmausbot-test-capability": testKey },
    );
    NodeAssert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.token as string;
  };
  const token = await mint();
  proxy = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(serverDir, "drivers/agents-proxy.js")],
    {
      windowsHide: true,
      env: {
        ...mausbotChildEnvironment(),
        OMB_HARNESS_URL: origin,
        OMB_BOT_ID: botId,
        OMB_THREAD_ID: threadId,
        OMB_COMMS_TOKEN: token,
        OMB_MEMORY_ENABLED: "1",
        OMB_TURN_DEPTH: "0",
        OMB_EXTERNAL_RUNTIME: "1",
      },
    },
  );
  let next = 0;
  const replies = new Map<number, (value: Record<string, unknown>) => void>();
  NodeReadline.createInterface({ input: proxy.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (typeof frame.id === "number") {
      const resolve = replies.get(frame.id);
      replies.delete(frame.id);
      resolve?.(frame);
    }
  });
  const rpc = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      replies.set(id, resolve);
      proxy!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "synthetic-provider", version: "1" },
  });
  const listed = JSON.stringify(await rpc("tools/list", {}));
  NodeAssert.ok(listed.includes("hive_mind_recall") && listed.includes("hive_mind_remember"));
  const fact = `SYNTHETIC_PROVIDER_HIVE_${NodeCrypto.randomUUID()}`;
  const saved = JSON.stringify(
    await rpc("tools/call", {
      name: "hive_mind_remember",
      arguments: {
        scope: "project",
        project: "Synthetic bot wiring",
        subject: "Isolated native provider proof",
        fact,
      },
    }),
  );
  NodeAssert.ok(saved.includes(fact), saved);
  NodeAssert.equal(records.size, 1);
  const found = JSON.stringify(
    await rpc("tools/call", {
      name: "hive_mind_recall",
      arguments: { query: fact, project: "Synthetic bot wiring" },
    }),
  );
  NodeAssert.ok(found.includes(fact), found);
  rejectHiveWrites = true;
  const refusedWrite = await rpc("tools/call", {
    name: "hive_mind_remember",
    arguments: {
      scope: "project",
      project: "Synthetic bot wiring",
      subject: "refused upstream",
      fact: "not stored",
    },
  });
  NodeAssert.equal((refusedWrite.result as { isError: boolean }).isError, true);
  NodeAssert.equal(records.size, 1);
  rejectHiveWrites = false;
  NodeAssert.equal([...records.values()][0]!.sourceThreadId, `mausbot:${botId}:${threadId}`);
  const invoke = (cap: string, argumentsValue: unknown, name = "hive_mind_recall") =>
    api(
      "/api/internal/j1-hive-memory",
      "POST",
      { name, arguments: argumentsValue },
      { authorization: `Bearer ${cap}` },
    );
  const before = requests;
  NodeAssert.equal((await invoke(token, { query: fact, botId: "forged" })).status, 400);
  await api(`/api/bots/${botId}`, "PATCH", { memoryEnabled: false });
  NodeAssert.equal((await invoke(token, { query: fact })).status, 403);
  await api(`/api/bots/${botId}`, "PATCH", {
    memoryEnabled: true,
    toolScope: { allow: ["mcp:agents:hive_mind_recall"] },
  });
  NodeAssert.equal(
    (
      await invoke(
        token,
        { scope: "project", project: "Synthetic bot wiring", subject: "refused", fact: "refused" },
        "hive_mind_remember",
      )
    ).status,
    403,
  );
  NodeAssert.equal((await invoke(token, { query: fact })).status, 200);
  NodeAssert.equal(requests, before + 1);
  const wrongService = await mint("computer");
  NodeAssert.equal((await invoke(wrongService, { query: fact })).status, 403);
  NodeAssert.equal((await api(`/api/bots/${botId}/interrupt`, "POST", { threadId })).status, 200);
  NodeAssert.equal((await invoke(token, { query: fact })).status, 401);
  NodeAssert.equal(records.size, 1);
  console.log(
    "J1_HIVE_PROVIDER_BRIDGE_OK: bundled bot MCP catalogue, native stdio tool write/readback, active bot/turn capability, private parent IPC, real selected-descriptor HTTP, anchored provenance, forged identity/memory-off/read-only/upstream-write-denial/stale-turn/wrong-service rejection. Hive service is an isolated fixture; no real bot or hosted Dot was contacted.",
  );
} finally {
  proxy?.kill();
  if (proxy) await NodeEvents.once(proxy, "exit").catch(() => {});
  child.kill();
  await NodeEvents.once(child, "exit").catch(() => {});
  await new Promise<void>((r) => hive.close(() => r()));
  console.log(`Isolated evidence: ${sandbox}; verified archive=${archive}`);
}
