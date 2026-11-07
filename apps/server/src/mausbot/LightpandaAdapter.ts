import * as NodeCrypto from "node:crypto";
import type { LightpandaPool } from "../mcp/LightpandaProcess.ts";

const aliases = {
  agent_browser_open: "goto",
  agent_browser_snapshot: "tree",
  agent_browser_get_url: "getUrl",
  agent_browser_get_text: "markdown",
  agent_browser_read: "markdown",
  agent_browser_click: "click",
  agent_browser_fill: "fill",
  agent_browser_press: "press",
  agent_browser_hover: "hover",
  agent_browser_select: "selectOption",
  agent_browser_wait_for_selector: "waitForSelector",
  agent_browser_screenshot: "screenshot",
} as const;

type Tool = { name: string; description?: string; inputSchema: unknown };
type Result = { isError?: boolean; content: ReadonlyArray<unknown> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One runtime conversation owns one native page, shared by tool calls and its viewer. */
export class MausbotLightpandaAdapter {
  private readonly pool: Pick<LightpandaPool, "request" | "requestExisting" | "close">;
  private readonly executable: string;

  constructor(
    pool: Pick<LightpandaPool, "request" | "requestExisting" | "close">,
    executable: string,
  ) {
    this.pool = pool;
    this.executable = executable;
  }

  sessionId(runtimeId: string, conversationId: string) {
    if (!runtimeId || !conversationId) throw new Error("Missing browser conversation identity.");
    return `mausbot:${NodeCrypto.createHash("sha256")
      .update(JSON.stringify([runtimeId, conversationId]))
      .digest("hex")}`;
  }

  async request(
    runtimeId: string,
    conversationId: string,
    method: "tools/list" | "tools/call",
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const session = this.sessionId(runtimeId, conversationId);
    if (method === "tools/list") {
      const catalog = await this.pool.request(session, this.executable, method, {}, signal);
      if (!record(catalog) || !Array.isArray(catalog.tools))
        throw new Error("The native browser returned an invalid tool catalog.");
      const tools = catalog.tools.filter(
        (tool): tool is Tool =>
          record(tool) && typeof tool.name === "string" && "inputSchema" in tool,
      );
      return {
        tools: Object.entries(aliases).flatMap(([name, native]) => {
          const tool = tools.find((candidate) => candidate.name === native);
          if (!tool) return [];
          const hidden =
            native === "goto" ? [] : native === "screenshot" ? ["url", "path"] : ["url"];
          const schema = tool.inputSchema;
          const inputSchema = record(schema)
            ? {
                ...schema,
                ...(record(schema.properties)
                  ? {
                      properties: Object.fromEntries(
                        Object.entries(schema.properties).filter(([key]) => !hidden.includes(key)),
                      ),
                    }
                  : {}),
                ...(Array.isArray(schema.required)
                  ? {
                      required: schema.required.filter(
                        (key) => typeof key === "string" && !hidden.includes(key),
                      ),
                    }
                  : {}),
              }
            : schema;
          return [{ ...tool, name, inputSchema }];
        }),
      };
    }
    if (
      !record(params) ||
      typeof params.name !== "string" ||
      (params.arguments !== undefined && !record(params.arguments))
    )
      throw new Error("Invalid browser call.");
    const native = Object.hasOwn(aliases, params.name)
      ? aliases[params.name as keyof typeof aliases]
      : undefined;
    if (native === undefined)
      return {
        isError: true,
        content: [{ type: "text", text: "This action is unavailable in the lightweight browser." }],
      };
    const args = { ...(params.arguments ?? {}) };
    // Read tools must stay on the existing page; navigation has its own explicit tool.
    if (native !== "goto") delete args.url;
    if (native === "screenshot") delete args.path;
    const result = await this.pool.request(
      session,
      this.executable,
      "tools/call",
      { name: native, arguments: args },
      signal,
    );
    if (native !== "goto" || !record(result) || result.isError === true) return result;
    const tree = await this.pool.request(
      session,
      this.executable,
      "tools/call",
      { name: "tree", arguments: { maxBytes: 16_000 } },
      signal,
    );
    if (!record(tree) || !Array.isArray(tree.content) || tree.isError === true) return result;
    if (!Array.isArray(result.content)) throw new Error("Invalid native navigation response.");
    const navigation = result as Result;
    return { ...result, content: [...navigation.content, ...tree.content] };
  }

  /** A viewer may attach to an existing page, but may never open a duplicate URL/session. */
  view(
    runtimeId: string,
    conversationId: string,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ) {
    return this.pool.requestExisting(
      this.sessionId(runtimeId, conversationId),
      method,
      params,
      signal,
    );
  }

  close(runtimeId: string, conversationId: string) {
    return this.pool.close(this.sessionId(runtimeId, conversationId));
  }
}
