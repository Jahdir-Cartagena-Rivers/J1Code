// @effect-diagnostics nodeBuiltinImport:off - This is the narrow parent-owned loopback boundary for a captured child.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import {
  DeepAIRequestError,
  makeDeepAIClient,
  type DeepAIModel,
} from "../provider/deepai/DeepAIClient.ts";

type Catalog = { readonly models: ReadonlyArray<DeepAIModel>; readonly default: string };

export type DeepAIBridgeOptions = {
  /** Credential stays in the parent process. It is never sent to the child or a response body. */
  readonly credentials: () => Promise<string>;
  readonly catalog: (signal: AbortSignal) => Promise<Catalog>;
  readonly client?: ReturnType<typeof makeDeepAIClient>;
};

export type DeepAIBridge = {
  readonly baseUrl: string;
  readonly token: string;
  close(): Promise<void>;
};

const maxBodyBytes = 1_000_000;
const badRequest = (res: NodeHttp.ServerResponse, status: number, message: string) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: { message } }));
};

async function readJson(
  req: NodeHttp.IncomingMessage,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) throw new Error("The request is too large.");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

/**
 * Gives one Mausbot child a random, loopback-only capability for DeepAI chat.
 * It deliberately supports only chat-completions models: the bundled upstream
 * driver uses that contract for streaming tools and approvals. Responses-only
 * DeepAI models are omitted rather than silently translated.
 */
export async function startDeepAIBridge(options: DeepAIBridgeOptions): Promise<DeepAIBridge> {
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const client = options.client ?? makeDeepAIClient();
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const server = NodeHttp.createServer(async (req, res) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    // `close` is emitted for normal keep-alive completion too. `aborted` is the
    // request-side signal that the child actually disconnected mid-request.
    req.once("aborted", () => controller.abort());
    try {
      if (req.headers.authorization !== `Bearer ${token}`)
        return badRequest(res, 401, "Unauthorized.");
      // The capability is for the captured child only. A browser never needs it.
      if (req.headers.origin)
        return badRequest(res, 403, "Browser origins cannot call this endpoint.");
      if (req.method === "GET" && req.url === "/v1/models") {
        // Do not advertise models after the parent has lost its DeepAI session.
        await options.credentials();
        const catalog = await options.catalog(signal);
        const models = catalog.models.filter((model) => model.api !== "openai-responses");
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(
          JSON.stringify({
            object: "list",
            data: models.map((model) => ({
              id: model.id,
              object: "model",
              created: 0,
              owned_by: "deepai",
            })),
          }),
        );
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions")
        return badRequest(res, 404, "This DeepAI bridge endpoint is unavailable.");
      const body = await readJson(req, signal);
      const modelId = typeof body.model === "string" ? body.model : "";
      const catalog = await options.catalog(signal);
      const model = catalog.models.find((item) => item.id === modelId);
      if (!model || model.api === "openai-responses")
        return badRequest(res, 400, "This DeepAI model is unavailable to bots.");
      const upstream = await client.completion({
        apiKey: await options.credentials(),
        api: "openai-completions",
        body,
        signal,
      });
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (!res.write(next.value))
            await new Promise<void>((resolve) => res.once("drain", resolve));
        }
        res.end();
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = error instanceof DeepAIRequestError ? error.status : 502;
      badRequest(
        res,
        status,
        error instanceof DeepAIRequestError
          ? error.message
          : "DeepAI could not complete this bot request.",
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not start the DeepAI bot bridge.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    token,
    close: () =>
      (closing ??= (async () => {
        lifetime.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      })()),
  };
}
