// @effect-diagnostics nodeBuiltinImport:off - The private process boundary uses native paths and one-use cryptographic nonces.
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

export const CODEX_CONSULTATION_PROTOCOL = "j1-codex-consultation-v1";

export interface CodexConsultationLaunch {
  readonly nonce: string;
  readonly binaryPath: string;
  readonly directory: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  readonly digest: string;
}

const isolatedArgs = [
  "app-server",
  "--config", 'sandbox_mode="read-only"',
  "--config", 'approval_policy="never"',
  "--config", 'web_search="disabled"',
  "--config", "features.hooks=false",
  "--config", "features.codex_hooks=false",
  "--config", "features.plugins=false",
  "--config", "features.apps=false",
  "--config", "features.shell_tool=false",
] as const;

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function codexConsultationLaunch(
  executable: string,
  emptyDirectory: string,
  systemRoot?: string,
): CodexConsultationLaunch {
  if (!isAbsolute(executable) || !isAbsolute(emptyDirectory) ||
      (systemRoot !== undefined && !isAbsolute(systemRoot))) {
    throw new Error("An isolated absolute executable and working directory are required.");
  }
  const directory = resolve(emptyDirectory);
  const environment = {
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    CODEX_HOME: join(directory, "codex"),
    ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot, WINDIR: systemRoot }),
  };
  const plan = { nonce: randomUUID(), binaryPath: executable, directory, args: isolatedArgs, environment };
  return Object.freeze({
    ...plan, args: Object.freeze([...plan.args]), environment: Object.freeze(environment),
    digest: digest(plan),
  });
}

export interface CodexConsultationClaim {
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  /** Opaque revision for the exact selected account, provided by the credential broker. */
  readonly accountRevision: string;
  readonly sourceItemId: string;
  readonly prompt: string;
  readonly history: ReadonlyArray<{
    readonly itemId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
  readonly model: string;
  readonly isCurrent: () => Promise<boolean>;
  readonly signal: AbortSignal;
}

export interface CodexConsultationAttestation {
  readonly protocol: string;
  readonly nonce: string;
  readonly processId: string;
  readonly launchDigest: string;
  readonly configSources: ReadonlyArray<string>;
  readonly actionTools: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<string>;
  readonly hooks: ReadonlyArray<string>;
  readonly plugins: ReadonlyArray<string>;
  readonly apps: ReadonlyArray<string>;
  readonly authorization: string | null;
  readonly nativeThreadId: string | null;
  readonly nativeTurnId: string | null;
  readonly model: string | null;
  readonly historyDigest: string | null;
  readonly sandbox: string;
  readonly approval: string;
}

type WriteGuard = () => Promise<boolean>;

/** This capability must come from the private connection to the spawned child, never its model,
 * a normal app-server session, or a reply from ordinary config/read or mcpServerStatus/list.
 * Each mutating operation must enforce the guard immediately before its native write. Closing
 * the owned transport must reject outstanding calls as well as reap the child. */
export interface CodexConsultationChild {
  readonly processId: string;
  attest(): Promise<CodexConsultationAttestation>;
  bindAccount(input: {
    readonly providerInstanceId: string;
    readonly providerSessionId: string;
    readonly accountRevision: string;
    readonly authorize: WriteGuard;
  }): Promise<void>;
  createThread(input: { readonly model: string; readonly authorize: WriteGuard }): Promise<string>;
  injectHistory(input: {
    readonly nativeThreadId: string;
    readonly history: CodexConsultationClaim["history"];
    readonly authorize: WriteGuard;
  }): Promise<void>;
  start(input: {
    readonly nativeThreadId: string;
    readonly prompt: string;
    readonly authorize: WriteGuard;
  }): Promise<string>;
  close(): Promise<void>;
}

export interface CodexConsultationProcessFactory {
  readonly protocol: typeof CODEX_CONSULTATION_PROTOCOL;
  /** Allocates a fresh empty process root and owns its cleanup after the callback. */
  withEmptyRoot<T>(run: (root: string) => Promise<T>): Promise<T>;
  /** Must honor cancellation while opening and reap a partially started child. */
  spawn(plan: CodexConsultationLaunch, signal: AbortSignal): Promise<CodexConsultationChild>;
}

export async function startIsolatedCodexConsultation<T>(
  factory: CodexConsultationProcessFactory,
  executable: string,
  claim: CodexConsultationClaim,
  receive: (turn: { readonly nativeThreadId: string; readonly nativeTurnId: string },
    signal: AbortSignal) => Promise<T>,
  systemRoot?: string,
): Promise<T> {
  if (factory.protocol !== CODEX_CONSULTATION_PROTOCOL)
    throw new Error("Codex does not expose the isolated consultation process protocol.");
  const { providerInstanceId, providerSessionId, accountRevision, sourceItemId, prompt, model } = claim;
  const history = Object.freeze(claim.history.map(row =>
    Object.freeze({ itemId: row.itemId, role: row.role, text: row.text })));
  if (!providerInstanceId || !providerSessionId || !accountRevision || !model || !prompt.trim() ||
      history.some(row => !row.itemId || (row.role !== "user" && row.role !== "assistant")) ||
      new Set(history.map(row => row.itemId)).size !== history.length ||
      history.find(row => row.itemId === sourceItemId)?.role !== "assistant") {
    throw new Error("The consultation is missing its exact assistant history.");
  }
  const historyDigest = digest(history);
  const authorization = digest([providerInstanceId, providerSessionId, accountRevision]);
  const owned = new AbortController();
  const signal = AbortSignal.any([claim.signal, owned.signal]);
  const authorize = async () => !signal.aborted && await claim.isCurrent() && !signal.aborted;
  const check = async () => {
    if (!await authorize()) throw new Error("The original consultation is no longer current.");
  };
  await check();
  return factory.withEmptyRoot(async directory => {
    await check();
    const plan = codexConsultationLaunch(executable, directory, systemRoot);
    const child = await factory.spawn(plan, signal);
    const processId = child.processId;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= Promise.resolve().then(() => child.close());
    const stop = () => { void close().catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const verify = async (expectedAccount: string | null, thread: string | null,
        expectedHistory: string | null, turn: string | null = null) => {
        await check();
        const proof = await child.attest();
        if (!processId || proof.protocol !== CODEX_CONSULTATION_PROTOCOL ||
            proof.processId !== processId || proof.nonce !== plan.nonce || proof.launchDigest !== plan.digest ||
            !Array.isArray(proof.configSources) ||
            proof.configSources.length !== 1 || proof.configSources[0] !== "consultation-launch" ||
            ![proof.actionTools, proof.mcpServers, proof.hooks, proof.plugins, proof.apps]
              .every(items => Array.isArray(items) && items.length === 0) ||
            proof.sandbox !== "read-only" ||
            proof.approval !== "never" || proof.authorization !== expectedAccount ||
            proof.nativeThreadId !== thread || proof.historyDigest !== expectedHistory ||
            proof.nativeTurnId !== turn || proof.model !== (thread === null ? null : model)) {
          throw new Error("Codex did not attest an isolated consultation launch.");
        }
        await check();
      };
      const verifyAtWrite = (account: string | null, thread: string | null, expectedHistory: string | null) =>
        async () => {
          try {
            await verify(account, thread, expectedHistory);
            return true;
          } catch {
            return false;
          }
        };
      await verify(null, null, null);
      await child.bindAccount({
        providerInstanceId, providerSessionId, accountRevision, authorize: verifyAtWrite(null, null, null),
      });
      await verify(authorization, null, null);
      const nativeThreadId = await child.createThread({ model, authorize: verifyAtWrite(authorization, null, null) });
      if (!nativeThreadId) throw new Error("Codex did not return an owned consultation thread.");
      await verify(authorization, nativeThreadId, null);
      await child.injectHistory({ nativeThreadId, history, authorize: verifyAtWrite(authorization, nativeThreadId, null) });
      await verify(authorization, nativeThreadId, historyDigest);
      const nativeTurnId = await child.start({
        nativeThreadId, prompt, authorize: verifyAtWrite(authorization, nativeThreadId, historyDigest),
      });
      if (!nativeTurnId) throw new Error("Codex did not return an owned consultation turn.");
      await verify(authorization, nativeThreadId, historyDigest, nativeTurnId);
      // The result consumer can stall independently of the owned native transport.
      const cancelled = Promise.withResolvers<never>();
      const abort = () => cancelled.reject(signal.reason);
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      let result: T;
      try {
        result = await Promise.race([
          cancelled.promise,
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return receive({ nativeThreadId, nativeTurnId }, signal);
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      await check();
      return result;
    } finally {
      signal.removeEventListener("abort", stop);
      owned.abort();
      await close();
    }
  });
}
