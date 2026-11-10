import { it, expect, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createDeepAIAgent } from "./DeepAIAgent.ts";

it.each([true, false])(
  "desktop MCP respects approval=%s and closes its connection",
  async (allowed) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepai-desktop-test-"));
    const fixture = NodePath.join(root, "computer.mjs");
    await NodeFSP.writeFile(
      fixture,
      "import readline from 'node:readline';const image='aW1hZ2U=';\nfor await (const line of readline.createInterface({input:process.stdin})) {let r;try{r=JSON.parse(line);}catch{continue;}if(r.id===undefined)continue;const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture-desktop',version:'1'}}:r.method==='tools/list'?{tools:[{name:'desktop_inspect',description:'Synthetic desktop fixture; never accesses the desktop.',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'image',mimeType:'image/png',data:image}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}\n",
    );
    const bodies: Array<{ messages: unknown[]; tools?: Array<{ function?: { name: string } }> }> =
      [];
    let toolRan = false;
    const authorize = vi.fn(async () => allowed);
    const interpret = vi.fn(async () => "[Codex vision] Red square.");
    vi.stubGlobal("fetch", async (url: string | Request | URL, init?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, init);
      if (request.url.endsWith("/theos")) return Response.json({ enabled: true });
      const body = (await request.json()) as (typeof bodies)[number];
      bodies.push(body);
      const name = body.tools?.find((x: { function?: { name: string } }) =>
        /desktop_inspect/.test(x.function?.name ?? ""),
      )?.function?.name;
      const call = name && !toolRan;
      if (call) toolRan = true;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: "fixture-call",
                type: "function",
                function: { name, arguments: "{}" },
              },
            ],
          }
        : { content: "fixture" };
      return new Response(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    let agent: Awaited<ReturnType<typeof createDeepAIAgent>> | undefined;
    try {
      agent = await createDeepAIAgent({
        cwd: root,
        agentDir: NodePath.join(root, "agent"),
        sessionDir: NodePath.join(root, "sessions"),
        apiKey: "test-only",
        models: [
          {
            id: "fixture",
            name: "Fixture",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 4096,
            maxTokens: 512,
          },
        ],
        modelId: "fixture",
        systemPrompt: "Fixture only",
        authorize,
        onEvent: () => {},
        interpretToolImages: interpret,
        computer: { mcpCommand: process.execPath, mcpArgs: [fixture], mcpEnv: {} },
      });
      await agent.session.prompt("Inspect the fixture");
      expect(agent.session.getAllTools().some((tool) => /desktop_inspect/.test(tool.name))).toBe(
        true,
      );
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(interpret).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) expect(JSON.stringify(bodies.at(-1))).toContain("Red square");
      expect(JSON.stringify(bodies.at(-1))).not.toContain("image_url");
    } finally {
      await agent?.stop();
      vi.unstubAllGlobals();
      await NodeFSP.rm(root, { recursive: true });
    }
  },
);
