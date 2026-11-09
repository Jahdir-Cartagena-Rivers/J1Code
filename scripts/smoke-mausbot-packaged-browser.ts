import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { resolveMausbotResources } from "../apps/server/src/mausbot/Resources.ts";
import { MausbotRuntime } from "../apps/server/src/mausbot/Runtime.ts";

const [archive, executable] = process.argv.slice(2);
if (!archive || !executable)
  throw new Error("Supply the runtime archive directory and Lightpanda executable.");
const sandbox = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-packaged-browser-"));
const resources = await resolveMausbotResources(
  NodePath.resolve(archive),
  NodePath.join(sandbox, "cache"),
);
const runtime = new MausbotRuntime({
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone host runtime smoke.
  platform: process.platform,
  resources,
  dataDir: NodePath.join(sandbox, "state"),
  lightpandaExecutablePath: NodePath.resolve(executable),
});
const fixture = NodeHttp.createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(
    '<!doctype html><title>Packaged Lightpanda</title><input id="name"><h1>J1_PACKAGED_LIGHTPANDA_OK</h1>',
  );
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
NodeAssert.ok(address && typeof address !== "string");
try {
  await runtime.start();
  const config = await (await runtime.forward("/api/config", "GET")).json();
  NodeAssert.ok(JSON.stringify(config).includes("j1-lightpanda"));
  const created = (await runtime.request("/api/bots", "POST", {
    name: "Native browser fixture",
  })) as { bot: { id: string } };
  const endpoint = `/api/bots/${created.bot.id}/browser/native`;
  const response = await runtime.forward(
    endpoint,
    "POST",
    "application/json",
    Buffer.from(
      JSON.stringify({
        type: "navigate",
        url: `http://127.0.0.1:${address.port}/`,
      }),
    ),
  );
  NodeAssert.equal(response.status, 200, await response.clone().text());
  const page = await response.json();
  NodeAssert.match(page.html, /J1_PACKAGED_LIGHTPANDA_OK/);
  await runtime.setBrowserExecutablePath("");
  NodeAssert.notEqual((await runtime.forward(endpoint, "GET")).status, 200);
  await runtime.setBrowserExecutablePath(NodePath.resolve(executable));
  const reopened = await runtime.forward(
    endpoint,
    "POST",
    "application/json",
    Buffer.from(JSON.stringify({ type: "open" })),
  );
  NodeAssert.equal(reopened.status, 200, await reopened.clone().text());
  NodeAssert.ok(
    !(await reopened.json()).html.includes("J1_PACKAGED_LIGHTPANDA_OK"),
    "Disabled sessions must close their pages.",
  );
  console.log(
    "J1_PACKAGED_LIGHTPANDA_OK: packaged bot browser route, native navigation, disable and clean reopen.",
  );
} finally {
  await runtime.stop();
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
}
