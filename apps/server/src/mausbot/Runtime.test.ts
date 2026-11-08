// @effect-diagnostics nodeBuiltinImport:off - Exercises the real child/loopback boundary with isolated fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { MausbotRuntime } from "./Runtime.ts";

const fixtureSource = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let owner = '';
let browser = process.env.J1_MAUSBOT_LIGHTPANDA_PATH;
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { owner += value; });
fs.writeFileSync(path.join(process.env.OMB_DATA_DIR, 'fixture-pid'), String(process.pid));
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'; connect-src 'self'");
  if(req.url === '/api/edition') return res.end(JSON.stringify({edition:'oss'}));
  if(req.url === '/api/auth/pairing') {
    if(req.headers['x-openmausbot-cli-owner'] !== owner.trim()) { res.statusCode = 403; return res.end('{}'); }
    return res.end(JSON.stringify({code:'fixture-only-code'}));
  }
  if(req.url === '/api/auth/pair') return res.end(JSON.stringify({token:'fixture-only-token'}));
  if(req.headers.authorization !== 'Bearer fixture-only-token') { res.statusCode = 401; return res.end('{}'); }
  if(req.url === '/api/bots/redirect') { res.statusCode = 302; res.setHeader('location','https://example.invalid'); return res.end('{}'); }
  if(req.url === '/api/bots/large') return res.end(JSON.stringify('x'.repeat(4*1024*1024)));
  if(req.url === '/api/bots/browser-path') return res.end(JSON.stringify({browser}));
  if(req.url === '/fixture-ui') return res.end(JSON.stringify({html:fs.readFileSync(path.join(process.env.OMB_STATIC_DIR,'index.html'),'utf8')}));
  res.end(JSON.stringify({ok:true,method:req.method,trust:process.env.OMB_LOOPBACK_TRUST,dataDir:process.env.OMB_DATA_DIR}));
});
process.on('message', message => {
  if(message?.type === 'j1:conversation-query') {
    if(message.input.query === 'hold') process.send({type:'j1:conversation-host-request',requestId:message.requestId,input:{receipt:'started'}});
    else process.send({type:'j1:conversation-result',requestId:message.requestId,value:{input:message.input,private:true}});
  }
  if(message?.type === 'j1:shutdown') server.close(() => process.exit(0));
  if(message?.type === 'j1:browser') { browser = message.executable; process.send({type:'j1:browser-applied',requestId:message.requestId}); }
});
// Announce readiness only after the owner credential has arrived on stdin.
process.stdin.on('end', () => server.listen(Number(process.env.OMB_PORT), '127.0.0.1', () => console.log('openmausbot server on http://127.0.0.1:'+process.env.OMB_PORT)));
`;

async function fixture(
  conversationCall?: ConstructorParameters<typeof MausbotRuntime>[0]["conversationCall"],
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-mausbot-runtime-test-"));
  const resources = NodePath.join(root, "resources");
  const dataDir = NodePath.join(root, "state");
  await NodeFSP.mkdir(NodePath.join(resources, "server"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(resources, "ui"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(resources, "ui", "index.html"), "packaged ui");
  await NodeFSP.writeFile(NodePath.join(resources, "server", "index.js"), fixtureSource);
  const runtime = new MausbotRuntime({
    platform: "linux",
    resources,
    dataDir,
    ...(conversationCall ? { conversationCall } : {}),
  });
  return { runtime, resources, dataDir, root };
}

describe("managed upstream runtime", () => {
  it("serves successive development UI edits without another archive or child restart", async () => {
    const { root, resources, dataDir } = await fixture();
    const uiDir = NodePath.join(root, "watch-output");
    await NodeFSP.mkdir(uiDir);
    await NodeFSP.writeFile(NodePath.join(uiDir, "index.html"), "first build");
    const runtime = new MausbotRuntime({ platform: "linux", resources, dataDir, uiDir });
    try {
      await runtime.start();
      const pid = await NodeFSP.readFile(NodePath.join(dataDir, "fixture-pid"), "utf8");
      expect(await (await runtime.forward("/fixture-ui", "GET")).json()).toEqual({
        html: "first build",
      });
      await NodeFSP.writeFile(NodePath.join(uiDir, "index.html"), "incremental update");
      expect(await (await runtime.forward("/fixture-ui", "GET")).json()).toEqual({
        html: "incremental update",
      });
      expect(await NodeFSP.readFile(NodePath.join(dataDir, "fixture-pid"), "utf8")).toBe(pid);
      await expect(runtime.forward("/api/internal/j1-conversations", "GET")).rejects.toThrow(
        "private",
      );
    } finally {
      await runtime.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("fails a missing development build before starting a child", async () => {
    const { root, resources, dataDir } = await fixture();
    const runtime = new MausbotRuntime({
      platform: "linux",
      resources,
      dataDir,
      uiDir: NodePath.join(root, "missing"),
    });
    try {
      await expect(runtime.start()).rejects.toThrow();
      expect(runtime.running).toBe(false);
    } finally {
      await runtime.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("reads on its private child channel and cancels an in-flight read without changing the session", async () => {
    const started = Promise.withResolvers<void>();
    const { runtime, root } = await fixture(async () => {
      started.resolve();
      return {};
    });
    const principal = { kind: "j1", environmentId: "local", threadId: "source" } as const;
    try {
      const input = { action: "search", principal, query: "real history" } as const;
      expect(await runtime.conversation(input)).toEqual({ input, private: true });
      const controller = new AbortController();
      const pending = runtime.conversation({ ...input, query: "hold" }, controller.signal);
      const rejected = expect(pending).rejects.toThrow("cancelled");
      await started.promise;
      controller.abort();
      await rejected;
      expect(await runtime.conversation(input)).toEqual({ input, private: true });
      expect(runtime.running).toBe(true);
    } finally {
      await runtime.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects an outstanding private read when its owned child stops", async () => {
    const started = Promise.withResolvers<void>();
    const { runtime, root } = await fixture(async () => {
      started.resolve();
      return {};
    });
    try {
      const pending = runtime.conversation({
        action: "search",
        principal: { kind: "j1", environmentId: "local", threadId: "source" },
        query: "hold",
      });
      const rejected = expect(pending).rejects.toThrow("disconnected");
      await started.promise;
      await runtime.stop();
      await rejected;
    } finally {
      await runtime.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("starts one isolated child, authenticates server-side, and stops its captured process", async () => {
    const { runtime, dataDir, root } = await fixture();
    try {
      await Promise.all([runtime.start(), runtime.start(), runtime.start()]);
      expect(runtime.running).toBe(true);
      await runtime.setBrowserExecutablePath("custom-lightpanda.exe");
      expect(await runtime.request("/api/bots/browser-path", "GET")).toEqual({
        browser: "custom-lightpanda.exe",
      });
      await runtime.setBrowserExecutablePath("");
      expect(await runtime.request("/api/bots/browser-path", "GET")).toEqual({ browser: "" });
      expect(await runtime.request("/api/bots", "GET")).toEqual({
        ok: true,
        method: "GET",
        trust: "service",
        dataDir,
      });
      const pid = Number(await NodeFSP.readFile(NodePath.join(dataDir, "fixture-pid"), "utf8"));
      await runtime.stop();
      expect(runtime.running).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(runtime.request("/api/bots", "GET")).rejects.toThrow("not running");
    } finally {
      await runtime.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects enterprise payloads before starting a process", async () => {
    const { runtime, resources, root } = await fixture();
    try {
      await NodeFSP.mkdir(NodePath.join(resources, "server", "enterprise"));
      await expect(runtime.start()).rejects.toThrow("enterprise code");
      expect(runtime.running).toBe(false);
    } finally {
      await runtime.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps upstream credentials server-side and denies private routes on the streaming transport", async () => {
    const { runtime, root } = await fixture();
    try {
      await runtime.start();
      const response = await runtime.forward("/api/bots?view=all", "GET");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, method: "GET" });
      expect(await (await runtime.forward("/fixture-ui", "GET")).json()).toEqual({
        html: "packaged ui",
      });
      expect([...response.headers.keys()]).not.toContain("authorization");
      const embedded = await runtime.forward(
        "/",
        "GET",
        undefined,
        undefined,
        undefined,
        "https://j1.example",
      );
      expect(embedded.headers.get("content-security-policy")).toBe(
        "default-src 'self'; frame-ancestors 'self' https://j1.example; connect-src 'self'",
      );
      for (const path of [
        "//other.invalid/",
        "/api/auth/pair",
        "/api/internal/browser/mcp",
        "/api/internal/j1-conversations",
        "/%2e%2e/api/bots",
        "/api/bots\\auth",
      ])
        await expect(runtime.forward(path, "POST")).rejects.toThrow();
      await expect(runtime.forward("/api/bots/redirect", "GET")).rejects.toThrow("redirects");
      await expect(runtime.forward("/api/updates/check", "GET")).rejects.toThrow(
        "J1 Code owns updates",
      );
      await expect(
        runtime.forward("/api/bots", "GET", undefined, new Uint8Array([1])),
      ).rejects.toThrow("body");
    } finally {
      await runtime.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects escaped routes, cross-service URLs, oversized requests and redirected responses", async () => {
    const { runtime, root } = await fixture();
    try {
      await runtime.start();
      for (const route of [
        "https://example.invalid/api/bots",
        "/api/auth/pairing",
        "/api/bots/%2e%2e/auth",
        "/api/bots/../auth",
        "/api/bots?token=x",
        "/api/bots\\auth",
      ])
        await expect(runtime.request(route, "POST", {})).rejects.toThrow("not exposed");
      await expect(runtime.request("/api/bots", "POST", "x".repeat(256 * 1024))).rejects.toThrow(
        "256 KiB",
      );
      await expect(runtime.request("/api/bots", "GET", {})).rejects.toThrow("cannot contain");
      await expect(runtime.request("/api/bots/redirect", "GET")).rejects.toThrow();
      await expect(runtime.request("/api/bots/large", "GET")).rejects.toThrow("4 MiB");
    } finally {
      await runtime.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
