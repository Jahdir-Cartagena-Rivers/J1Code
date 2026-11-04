// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import { LightpandaProcess } from "./LightpandaProcess.ts";

const fixture = `
import { createInterface } from 'node:readline';
let counter = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
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
