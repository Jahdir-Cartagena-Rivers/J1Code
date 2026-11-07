import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

const [stage, executable] = process.argv.slice(2);
if (!stage || !executable)
  throw new Error("Supply a patched OSS source assembly and a native Lightpanda executable.");
process.env.J1_MAUSBOT_MANAGED = "1";
process.env.J1_MAUSBOT_LIGHTPANDA_PATH = executable;
const native = await import(
  pathToFileURL(NodePath.join(stage, "server/j1/native-browser.ts")).href
);
const { RuntimeRouter } = await import(
  pathToFileURL(NodePath.join(stage, "server/browser/engines.ts")).href
);
const fixture = NodeHttp.createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(
    '<!doctype html><title>Shared native browser</title><form><input id="name"><button>Send</button></form><h1>WAITING</h1><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();document.querySelector("h1").textContent=document.querySelector("#name").value}</script>',
  );
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("Fixture failed to listen.");
let allowed = true;
let claimed = 0;
const router = new RuntimeRouter(
  {
    agentRpc() {
      throw new Error("Legacy browser must never run.");
    },
  },
  {},
  {
    afterClaim: () => (allowed ? null : "Approval is required."),
  },
);
const spec = { command: native.command, args: [], env: {} };
const call = (name: string, args: unknown) =>
  router.agentRpc("fixture", spec, "tools/call", { name, arguments: args }, () => {
    claimed++;
  });
try {
  const catalog = await router.agentRpc("fixture", spec, "tools/list", {});
  NodeAssert.ok(catalog.tools.some((tool: { name: string }) => tool.name === "agent_browser_open"));
  NodeAssert.ok(!catalog.tools.some((tool: { name: string }) => tool.name === "getEnv"));
  await call("agent_browser_open", { url: `http://127.0.0.1:${address.port}/` });
  await call("agent_browser_fill", { selector: "#name", value: "J1_MAUSBOT_NATIVE_ROUTER_OK" });
  await call("agent_browser_click", { selector: "button" });
  const page = await native.page("fixture");
  NodeAssert.match(page.html, /<h1>J1_MAUSBOT_NATIVE_ROUTER_OK<\/h1>/);
  // The window writes back through the same page's revision-checked controls.
  const node = /<input[^>]*data-j1-browser-node="(\d+)"/.exec(page.html);
  NodeAssert.ok(node);
  await native.page("fixture", {
    type: "fill",
    node: Number(node[1]),
    revision: page.revision,
    value: "USER_ON_THE_SAME_PAGE",
  });
  const read = await call("agent_browser_get_text", {});
  const next = await native.page("fixture");
  NodeAssert.match(next.html, /USER_ON_THE_SAME_PAGE/);
  NodeAssert.ok(read.content.length > 0);
  allowed = false;
  const denied = await call("agent_browser_fill", { selector: "#name", value: "MUST_NOT_APPLY" });
  NodeAssert.equal(denied.isError, true);
  NodeAssert.match((await native.page("fixture")).html, /USER_ON_THE_SAME_PAGE/);
  NodeAssert.equal(claimed, 5);
  NodeAssert.equal(process.env.J1_MAUSBOT_LIGHTPANDA_PATH, undefined);
  native.configure("");
  NodeAssert.equal(native.ready, false);
  await NodeAssert.rejects(native.rpc("fixture", "tools/list", {}), /disabled or unavailable/);
  native.configure(executable);
  NodeAssert.equal(native.ready, true);
  await NodeAssert.rejects(native.page("fixture"), /not running/);
  console.log(
    "J1_MAUSBOT_NATIVE_ROUTER_OK: shared page, approval refusal, live disable/override closes old sessions, no legacy fallback.",
  );
} finally {
  native.closeAll();
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
}
