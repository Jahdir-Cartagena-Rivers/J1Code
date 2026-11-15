// @effect-diagnostics nodeBuiltinImport:off -- Local native process/HTTP integration fixture.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { persistentLightpandaPool } from "./LightpandaProcess.ts";

const executable = process.env.J1_LIGHTPANDA_TEST_EXECUTABLE;
describe.skipIf(!executable)("native bot cookie persistence", () => {
  it("retains HttpOnly session cookies across pool recreation and isolates other bots and guests", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-cookie-test-"));
    const requests: Array<{ url: string; signedIn: boolean }> = [];
    const server = NodeHttp.createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        signedIn: request.headers.cookie?.includes("fixture_session=retained") ?? false,
      });
      if (request.url === "/login")
        response.setHeader(
          "Set-Cookie",
          "fixture_session=retained; HttpOnly; Path=/; SameSite=Lax",
        );
      response.setHeader("Content-Type", "text/html");
      response.end("<html><body>Local browser fixture</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const origin = `http://127.0.0.1:${address.port}`;
    let pool = persistentLightpandaPool(directory);
    const navigate = (id: string, path: string) =>
      pool.request(id, executable!, "tools/call", {
        name: "goto",
        arguments: { url: origin + path, waitUntil: "domcontentloaded" },
      });
    try {
      await navigate("mausbot:owner", "/login");
      pool.close("mausbot:owner");
      // Immediate reuse must wait for the old process to save before it loads.
      await navigate("mausbot:owner", "/same-pool");
      expect(requests.find((r) => r.url === "/same-pool")?.signedIn).toBe(true);
      await pool.closeAll();
      pool = persistentLightpandaPool(directory);
      await navigate("mausbot:owner", "/restart");
      await navigate("mausbot:other", "/other");
      await navigate("mausbot:guest:temporary", "/guest");
      expect(requests.find((r) => r.url === "/restart")?.signedIn).toBe(true);
      expect(requests.find((r) => r.url === "/other")?.signedIn).toBe(false);
      expect(requests.find((r) => r.url === "/guest")?.signedIn).toBe(false);
      await pool.closeAll();
      expect(await NodeFSP.readdir(directory)).toHaveLength(2);
    } finally {
      await pool.closeAll();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

it("preserves malformed saved cookies rather than silently replacing a profile", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-cookie-corrupt-"));
  const id = "mausbot:owner";
  const file = NodePath.join(
    directory,
    NodeCrypto.createHash("sha256").update(id).digest("hex") + ".json",
  );
  const damaged = "{incomplete";
  await NodeFSP.writeFile(file, damaged);
  const pool = persistentLightpandaPool(directory);
  try {
    await expect(pool.request(id, "not-started", "tools/list", {})).rejects.toThrow("preserved");
    expect(await NodeFSP.readFile(file, "utf8")).toBe(damaged);
  } finally {
    await pool.closeAll();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
