import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const Model = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,128}$/)),
  name: Schema.NonEmptyString,
  reasoning: Schema.Boolean,
  input: Schema.Array(Schema.Literals(["text", "image"])),
  contextWindow: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  maxTokens: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  premier: Schema.optionalKey(Schema.Boolean),
  api: Schema.optionalKey(Schema.Literal("openai-responses")),
  theosPerRequest: Schema.optionalKey(Schema.String),
});
const Catalog = Schema.Struct({
  models: Schema.Array(Model),
  default: Schema.String,
});
const Allowance = Schema.Struct({
  enabled: Schema.Boolean,
  balance: Schema.optionalKey(Schema.String),
  granted: Schema.optionalKey(Schema.String),
  refresh_at: Schema.optionalKey(Schema.String),
  lane_version: Schema.optionalKey(Schema.Number),
  check_in: Schema.optionalKey(
    Schema.Struct({
      nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
      seconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    }),
  ),
});

export type DeepAIModel = typeof Model.Type;
const decodeCatalog = Schema.decodeUnknownSync(Catalog);
const decodeAllowance = Schema.decodeUnknownSync(Allowance);

/** Upstream bodies may echo prompts or credentials; expose only fixed messages. */
export class DeepAIRequestError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;
  constructor(status: number, retryAfter: string | null = null) {
    super(
      status === 401
        ? "Sign in to DeepAI again."
        : status === 402
          ? "DeepAI requires a subscription or additional allowance for this request."
          : status === 429
            ? "DeepAI is at capacity or its request limit was reached."
            : `DeepAI request failed (HTTP ${status}).`,
    );
    this.name = "DeepAIRequestError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Server-only wire boundary. The caller owns credentials and cancellation. */
export function makeDeepAIClient(
  options: {
    readonly request?: typeof fetch;
    readonly machineDigest?: string;
  } = {},
) {
  const request = options.request ?? fetch;
  const instance = NodeCrypto.randomBytes(16).toString("hex");
  if (options.machineDigest && !/^[a-f0-9]{64}$/.test(options.machineDigest)) {
    throw new Error("Invalid DeepAI machine digest.");
  }

  async function send(
    path: "/models" | "/theos" | "/chat/completions" | "/responses",
    apiKey: string | undefined,
    signal: AbortSignal,
    body?: unknown,
  ) {
    if (apiKey !== undefined && (!apiKey.trim() || /[\r\n]/.test(apiKey))) {
      throw new Error("Invalid DeepAI credential.");
    }
    const response = await request(`https://api.deepai.org/deepai_code${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DeepAI-Code-Theos": "4",
        "X-DeepAI-Code-Instance": instance,
        ...(options.machineDigest ? { "X-DeepAI-Code-Machine": options.machineDigest } : {}),
        ...(apiKey ? { "Api-Key": apiKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DeepAIRequestError(response.status, response.headers.get("retry-after"));
    }
    return response;
  }

  return {
    async models(signal: AbortSignal) {
      const response = await send("/models", undefined, signal);
      const catalog = decodeCatalog(await response.json());
      const ids = new Set(catalog.models.map((model) => model.id));
      if (
        catalog.models.length === 0 ||
        catalog.models.length > 100 ||
        ids.size !== catalog.models.length ||
        !ids.has(catalog.default) ||
        catalog.models.some(
          (model) => model.maxTokens > model.contextWindow || !model.input.includes("text"),
        )
      ) {
        throw new Error("Invalid DeepAI model catalog.");
      }
      return catalog;
    },
    async allowance(apiKey: string, signal: AbortSignal) {
      const response = await send("/theos", apiKey, signal);
      return decodeAllowance(await response.json());
    },
    async completion(input: {
      readonly apiKey: string;
      readonly api: "openai-completions" | "openai-responses";
      readonly body: Readonly<Record<string, unknown>>;
      readonly signal: AbortSignal;
    }) {
      const response = await send(
        input.api === "openai-responses" ? "/responses" : "/chat/completions",
        input.apiKey,
        input.signal,
        input.body,
      );
      if (!response.body) throw new Error("DeepAI returned an empty response.");
      return response;
    },
  };
}
