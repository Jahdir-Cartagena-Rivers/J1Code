import * as NodePerfHooks from "node:perf_hooks";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

// The upstream instance identifies a running host, not a conversation or refresh.
const hostInstance = NodeCrypto.randomBytes(16).toString("hex");
type CheckIn = { nonce: string; seconds: number };
type AccountState = {
  checkIn?: CheckIn;
  allowance?: typeof Allowance.Type;
  checkedAt: number;
  pending?: Promise<typeof Allowance.Type>;
};
const hostAccounts = new Map<string, AccountState>();

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
  constructor(status: number, retryAfter: string | null = null, code?: string) {
    super(
      code === "check_in_refused"
        ? "DeepAI refused the connection check-in: too many restarts today. Try again after DeepAI's daily reset. Signing in again will not clear this limit."
        : code === "machine_required"
          ? "DeepAI could not identify this server's machine. Check the server's system-information access."
          : status === 401
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
    readonly now?: () => number;
    readonly machineDigest?: string;
    readonly resolveMachineDigest?: () => Promise<string | undefined>;
  } = {},
) {
  const request = options.request ?? fetch;
  const now = options.now ?? (() => NodePerfHooks.performance.now());
  const accounts = options.request ? new Map<string, AccountState>() : hostAccounts;
  const accountState = (key: string) => {
    const id = NodeCrypto.createHash("sha256").update(key).digest("hex");
    let state = accounts.get(id);
    if (!state) {
      state = { checkedAt: 0 };
      accounts.set(id, state);
    }
    return state;
  };
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
    const machineDigest = options.machineDigest ?? (await options.resolveMachineDigest?.());
    const response = await request(`https://api.deepai.org/deepai_code${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DeepAI-Code-Theos": "4",
        "X-DeepAI-Code-Instance": hostInstance,
        ...(machineDigest ? { "X-DeepAI-Code-Machine": machineDigest } : {}),
        ...(path === "/theos" && apiKey
          ? {
              ...(accountState(apiKey).checkIn
                ? { "X-DeepAI-Code-Check-In": accountState(apiKey).checkIn!.nonce }
                : {}),
              "X-DeepAI-Code-Beacon": `up=${Math.floor(process.uptime())}`,
            }
          : {}),
        ...(apiKey ? { "Api-Key": apiKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const code =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        payload.error &&
        typeof payload.error === "object" &&
        "code" in payload.error &&
        typeof payload.error.code === "string"
          ? payload.error.code
          : undefined;
      throw new DeepAIRequestError(response.status, response.headers.get("retry-after"), code);
    }
    return response;
  }

  return {
    headers: {
      "X-DeepAI-Code-Theos": "4",
      "X-DeepAI-Code-Instance": hostInstance,
      ...(options.machineDigest ? { "X-DeepAI-Code-Machine": options.machineDigest } : {}),
    },
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
      const state = accountState(apiKey);
      const freshness = state.checkIn ? state.checkIn.seconds * 500 : 30000;
      if (state.allowance && now() - state.checkedAt < freshness) return state.allowance;
      if (state.pending) return state.pending;
      state.pending = (async () => {
        const response = await send("/theos", apiKey, signal);
        const allowance = decodeAllowance(await response.json());
        if (allowance.check_in) state.checkIn = allowance.check_in;
        else delete state.checkIn;
        state.checkedAt = now();
        state.allowance = allowance;
        return allowance;
      })();
      try {
        return await state.pending;
      } finally {
        delete state.pending;
      }
    },
    async completion(input: {
      readonly apiKey: string;
      readonly api: "openai-completions" | "openai-responses";
      readonly body: Readonly<Record<string, unknown>>;
      readonly signal: AbortSignal;
    }) {
      const allowance = await this.allowance(input.apiKey, input.signal);
      if (!allowance.enabled) throw new Error("DeepAI is not enabled for this account.");
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
