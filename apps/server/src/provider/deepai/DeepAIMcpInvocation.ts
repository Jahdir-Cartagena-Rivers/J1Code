// @effect-diagnostics nodeBuiltinImport:off - Pi invokes the transport from native Promise callbacks.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export const DEEPAI_INVOCATION_HEADER = "x-j1-deepai-invocation";

export interface DeepAIInvocationOrigin {
  readonly subject: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly providerSessionId: string;
}

const invocation = new AsyncLocalStorage<{ token: string; signal: AbortSignal }>();
const liveOrigins = new Map<string, Readonly<DeepAIInvocationOrigin>>();
const activeOrigins = new WeakSet<Readonly<DeepAIInvocationOrigin>>();
export const isLiveDeepAIOrigin = (origin: Readonly<DeepAIInvocationOrigin>) => activeOrigins.has(origin);

export async function withDeepAIInvocation<A>(
  origin: DeepAIInvocationOrigin,
  signal: AbortSignal,
  execute: () => Promise<A>,
): Promise<A> {
  if ([origin.subject, origin.environmentId, origin.projectId, origin.threadId, origin.runId,
    origin.messageId, origin.providerSessionId].some((value) => !value?.trim()))
    throw new Error("Verified DeepAI invocation provenance is required");
  signal.throwIfAborted();
  const token = randomBytes(32).toString("base64url");
  const captured = Object.freeze({ ...origin });
  const revoke = () => {
    liveOrigins.delete(token);
    activeOrigins.delete(captured);
  };
  liveOrigins.set(token, captured);
  activeOrigins.add(captured);
  signal.addEventListener("abort", revoke, { once: true });
  try {
    return await invocation.run({ token, signal }, execute);
  } finally {
    revoke();
    signal.removeEventListener("abort", revoke);
  }
}

export function resolveDeepAIInvocation(
  token: string | undefined,
  caller: Pick<DeepAIInvocationOrigin, "environmentId" | "threadId" | "providerSessionId">,
): Readonly<DeepAIInvocationOrigin> | undefined {
  const origin = token === undefined ? undefined : liveOrigins.get(token);
  return origin?.environmentId === caller.environmentId &&
    origin.threadId === caller.threadId && origin.providerSessionId === caller.providerSessionId
    ? origin
    : undefined;
}

export function deepAIMcpFetch(
  endpoint: string,
  request: (url: string | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  const allowed = new URL(endpoint).href;
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (new URL(url).href !== allowed) throw new Error("Unexpected DeepAI MCP destination");
    const headers = new Headers(init?.headers);
    headers.delete(DEEPAI_INVOCATION_HEADER);
    const proof = invocation.getStore();
    if (proof) {
      if (!liveOrigins.has(proof.token)) throw new Error("DeepAI invocation has ended");
      headers.set(DEEPAI_INVOCATION_HEADER, proof.token);
    }
    const signal = proof
      ? init?.signal ? AbortSignal.any([init.signal, proof.signal]) : proof.signal
      : init?.signal;
    return request(url, { ...init, headers, redirect: "error", ...(signal ? { signal } : {}) });
  };
}
