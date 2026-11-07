// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import { LightpandaProcess, LightpandaPool } from "./LightpandaProcess.ts";

const fixture = `
import { createInterface } from 'node:readline';
let counter = 0;
let held;
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'release') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:held,result:{counter:++counter}})+'\\n'); return; }
  if (!('id' in request)) return;
  if (request.method === 'hold') { held=request.id; process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'holding'})+'\\n'); return; }
  if (request.method === 'crash') { process.exit(7); return; }
  if (request.method === 'malformed') { process.stdout.write('not json\\n'); return; }
  const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : { counter: ++counter, params: request.params };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`;

const exited = (browser: LightpandaProcess) =>
  new Promise<void>((resolve) => browser.child.once("exit", () => resolve()));
const create = () =>
  new LightpandaProcess(process.execPath, ["--input-type=module", "-e", fixture]);
describe("Lightpanda subprocess transport", () => {
  it("opens a bot page once and preserves it when two viewers reconnect", async () => {
    const processes: LightpandaProcess[] = [];
    const pool = new LightpandaPool(() => {
      const child = create();
      processes.push(child);
      return child;
    });
    try {
      await Promise.all([
        pool.openThread("conversation", "fixture"),
        pool.openThread("conversation", "fixture"),
      ]);
      expect(processes).toHaveLength(1);
      const before = await pool.requestForThread("conversation", "echo", {});
      await pool.openThread("conversation", "fixture");
      const after = await pool.requestForThread("conversation", "echo", {});
      expect(before).toEqual({ counter: 2, params: {} });
      expect(after).toEqual({ counter: 3, params: {} });
    } finally {
      const exits = processes.map(exited);
      pool.closeAll();
      await Promise.all(exits);
    }
  });
  it("attaches viewer requests to the existing process and orders them after pending actions", async () => {
    const processes: LightpandaProcess[] = [];
    const pool = new LightpandaPool(() => {
      const child = create();
      processes.push(child);
      return child;
    });
    await expect(pool.requestExisting("bot", "echo", {})).rejects.toThrow("not running");
    expect(processes).toHaveLength(0);
    await pool.request("bot", "fixture", "echo", {}, undefined, "conversation");
    await expect(pool.requestForThread("other-conversation", "echo", {})).rejects.toThrow(
      "not running",
    );
    await expect(
      pool.request("bot", "fixture", "echo", {}, undefined, "other-conversation"),
    ).rejects.toThrow("another conversation");
    const browser = processes[0]!;
    const exit = exited(browser);
    try {
      const holding = new Promise<void>((resolve) => {
        const handler = (chunk: string) => {
          if (chunk.includes('"holding"')) {
            browser.child.stdout.off("data", handler);
            resolve();
          }
        };
        browser.child.stdout.on("data", handler);
      });
      const action = pool.request("bot", "fixture", "hold", {});
      await holding;
      const view = pool.requestForThread("conversation", "echo", { viewer: true });
      browser.child.stdin.write(JSON.stringify({ method: "release" }) + "\n");
      expect(await action).toEqual({ counter: 2 });
      expect(await view).toEqual({ counter: 3, params: { viewer: true } });
      expect(processes).toHaveLength(1);
    } finally {
      pool.closeAll();
      await exit;
    }
    await expect(pool.requestExisting("bot", "echo", {})).rejects.toThrow("not running");
    expect(processes).toHaveLength(1);
  });
  it("correlates concurrent requests and isolates each browser process", async () => {
    const first = create();
    const second = create();
    const exits = [exited(first), exited(second)];
    try {
      await Promise.all([first.initialize(), second.initialize()]);
      const results = await Promise.all([
        first.request("echo", { text: "one" }),
        first.request("echo", { text: "two" }),
        second.request("echo", { text: "private" }),
      ]);
      expect(results).toEqual([
        { counter: 1, params: { text: "one" } },
        { counter: 2, params: { text: "two" } },
        { counter: 1, params: { text: "private" } },
      ]);
    } finally {
      first.close();
      second.close();
      await Promise.all(exits);
    }
  });
  it("rejects work after a native process exits", async () => {
    const browser = create();
    const exit = exited(browser);
    await browser.initialize();
    await expect(browser.request("crash", {})).rejects.toThrow("exited (7)");
    await exit;
    await expect(browser.request("echo", {})).rejects.toThrow("closed");
  });
  it("rejects malformed output and terminates the owned process", async () => {
    const browser = create();
    const exit = exited(browser);
    await browser.initialize();
    await expect(browser.request("malformed", {})).rejects.toThrow("Malformed");
    await exit;
  });
});
