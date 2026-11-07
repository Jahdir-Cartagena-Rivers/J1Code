import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { resolveMausbotResources } from "../apps/server/src/mausbot/Resources.ts";
import { MausbotRuntime } from "../apps/server/src/mausbot/Runtime.ts";

if (!process.argv[2] || !process.argv[3])
  throw new Error("Supply the assembled runtime archive directory and Lightpanda executable.");
const sandbox = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-mausbot-packaged-smoke-"));
const resources = await resolveMausbotResources(
  NodePath.resolve(process.argv[2]),
  NodePath.join(sandbox, "cache"),
);
const memoryRequests: unknown[] = [];
const runtime = new MausbotRuntime({
  platform: process.platform,
  resources,
  dataDir: NodePath.join(sandbox, "state"),
  lightpandaExecutablePath: NodePath.resolve(process.argv[3]),
  memory: async (input) => {
    memoryRequests.push(input);
    const request = input as { action: string; documents?: { text: string }[] };
    return request.action === "status"
      ? { available: true, message: "Isolated memory transport fixture" }
      : { indexed: request.documents?.length ?? 0, context: "" };
  },
});
try {
  await Promise.all([runtime.start(), runtime.start()]);
  NodeAssert.equal(runtime.running, true);
  const ui = await runtime.forward("/", "GET");
  NodeAssert.equal(ui.status, 200);
  const html = await ui.text();
  NodeAssert.match(html, /\.\/assets\//);
  const entry = /src="(\.\/assets\/[^\"]+\.js)"/.exec(html);
  NodeAssert.ok(entry);
  const script = await runtime.forward(entry[1]!.slice(1), "GET");
  NodeAssert.equal(script.status, 200);
  NodeAssert.ok(
    (await script.text()).includes("Open this workspace from J1."),
    "The scoped client entry was not included.",
  );
  const session = await runtime.forward("/api/auth/session", "GET");
  NodeAssert.equal(session.status, 200);
  const config = await runtime.forward("/api/config", "GET");
  NodeAssert.equal(config.status, 200);
  const configuration = await config.json();
  NodeAssert.ok(
    JSON.stringify(configuration).includes("j1-lightpanda"),
    "The managed runtime did not report its native browser.",
  );
  if (process.platform === "win32")
    NodeAssert.equal(
      configuration.j1DesktopCapabilities.localComputer.available,
      true,
      "The real source runtime did not accept its owned native helper.",
    );
  const created = (await runtime.request("/api/bots", "POST", {
    name: "Memory integration fixture",
  })) as { bot: { id: string } };
  const botId = created.bot.id;
  const api = async (suffix: string, method: string, body?: unknown, status = 200) => {
    const result = await runtime.forward(
      `/api/bots/${botId}${suffix}`,
      method,
      "application/json",
      body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
    );
    NodeAssert.equal(result.status, status, `${method} ${suffix}`);
    return result.json();
  };
  const notes = `${"saved preference\n".repeat(230)}\n- 2020-01-01 · Old appointment · until 2020-01-02\nLATE_NOTE_OUTSIDE_PREFIX`;
  await api("/memory/file", "PUT", { path: "MEMORY.md", text: notes });
  NodeAssert.equal((await api("/memory/hive", "GET")).enabled, false);
  const selected = await api("/memory/hive", "PUT", { enabled: true });
  NodeAssert.equal(selected.enabled, true);
  const copied = memoryRequests.find(
    (value) => (value as { action: string }).action === "recall",
  ) as { documents: { text: string }[] };
  NodeAssert.ok(copied.documents[0]!.text.includes("LATE_NOTE_OUTSIDE_PREFIX"));
  NodeAssert.ok(!copied.documents[0]!.text.includes("Old appointment"));
  NodeAssert.equal(
    (await api("/memory/file", "GET")).text,
    notes,
    "Indexing must not rewrite original notes.",
  );
  await api("/memory/hive", "PUT", { enabled: false });
  NodeAssert.equal((await api("/memory/hive", "GET")).enabled, false);
  await runtime.request(`/api/bots/${botId}`, "PATCH", { memoryEnabled: false });
  const before = memoryRequests.length;
  await api("/memory/hive", "PUT", { enabled: true }, 409);
  NodeAssert.equal(memoryRequests.length, before, "Memory-off must reject before sharing notes.");
  const approval = await runtime.setApprovalMode({ botId, mode: "ask" });
  NodeAssert.ok(approval, "The original trusted approval handshake did not complete.");
  console.log(
    "J1_MAUSBOT_PACKAGED_RUNTIME_OK: verified archive, owned native helper acceptance, relative UI assets, private authentication, native browser, original trusted approval handshake, opt-in full-note Hive IPC, expired-note filtering, off/on and notes preservation. Hive transport is a fixture; no screen/input/model call was made.",
  );
} finally {
  await runtime.stop();
}
console.log(`Isolated smoke evidence retained at ${sandbox}`);
