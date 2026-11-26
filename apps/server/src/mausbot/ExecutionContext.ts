import type { MausbotOriginStart, MessageId, ProjectId, ProviderInteractionMode, RuntimeMode, ThreadId } from "@j1code/contracts";

import type { MausbotResumeTarget } from "../orchestration-v2/MausbotResume.ts";

export interface BotExecutionContext {
  readonly resume?: MausbotResumeTarget & {
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly runtimeMode: RuntimeMode;
    readonly verifyIncident?: (currentRunId?: string) => Promise<boolean>;
    readonly interactionMode: ProviderInteractionMode;
  };
  readonly origin?: {
    readonly input: MausbotOriginStart;
    readonly refresh: () => Promise<boolean>;
  };
  readonly restrictedTools: boolean;
  readonly prompt: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema: unknown;
  }>;
  readonly call: (name: string, arguments_: unknown, signal: AbortSignal) => Promise<unknown>;
}

interface BotExecutionOwner {
  readonly messageId: MessageId;
  readonly botId: string;
  readonly isCurrent: () => boolean;
}

export interface CapturedBotExecutionContext extends BotExecutionContext {
  readonly threadId: ThreadId;
  readonly owner?: Pick<BotExecutionOwner, "messageId" | "botId">;
  readonly isCurrent: () => boolean;
}

const contexts = new Map<ThreadId, CapturedBotExecutionContext>();
const credentials = new WeakMap<CapturedBotExecutionContext, string>();

export function registerBotExecutionContext(
  threadId: ThreadId, context: BotExecutionContext, owner?: BotExecutionOwner,
) {
  if (contexts.has(threadId)) throw new Error("This bot thread already has an active turn.");
  const controller = new AbortController();
  const invoke = context.call;
  const tools = Object.freeze(context.tools.map((tool) =>
    Object.freeze({ ...tool, inputSchema: structuredClone(tool.inputSchema) }),
  ));
  const selected = new Set(tools.map(({ name }) => name));
  const isCurrent = () => contexts.get(threadId) === captured && (owner?.isCurrent() ?? true);
  const captured: CapturedBotExecutionContext = Object.freeze({
    threadId,
    restrictedTools: context.restrictedTools,
    prompt: context.prompt,
    ...(context.resume ? { resume: Object.freeze({ ...context.resume }) } : {}),
    ...(context.origin ? { origin: Object.freeze({ ...context.origin }) } : {}),
    tools,
    ...(owner === undefined ? {} : { owner: Object.freeze({ botId: owner.botId, messageId: owner.messageId }) }),
    isCurrent,
    call: async (name: string, arguments_: unknown, signal: AbortSignal) => {
      if (!isCurrent() || signal.aborted) throw new Error("The bot turn ended.");
      if (!selected.has(name)) throw new Error("This tool was not selected for the bot turn.");
      const boundSignal = AbortSignal.any([signal, controller.signal]);
      const result = await invoke(name, arguments_, boundSignal);
      if (!isCurrent() || boundSignal.aborted) throw new Error("The bot turn ended.");
      return result;
    },
  });
  contexts.set(threadId, captured);
  return () => {
    if (contexts.get(threadId) !== captured) return;
    contexts.delete(threadId);
    controller.abort();
  };
}

export const captureBotExecutionContext = (threadId: ThreadId) => {
  const context = contexts.get(threadId);
  return context?.isCurrent() ? context : undefined;
};

export function bindBotExecutionCredential(
  threadId: ThreadId, captured: CapturedBotExecutionContext, credentialId: string,
): boolean {
  if (captureBotExecutionContext(threadId) !== captured || captured.owner === undefined) return false;
  credentials.set(captured, credentialId);
  return true;
}

export function ownsBotExecutionCredential(
  captured: CapturedBotExecutionContext, credentialId: string | undefined,
): boolean {
  return credentialId !== undefined && captured.isCurrent() && credentials.get(captured) === credentialId;
}

export function botExecutionContext(threadId: ThreadId, credentialId?: string): BotExecutionContext | undefined {
  const captured = captureBotExecutionContext(threadId);
  if (!captured || captured.owner === undefined || ownsBotExecutionCredential(captured, credentialId))
    return captured;

  // A thread-only lookup may observe restriction/presence, but cannot use V2's tool bridge.
  return {
    restrictedTools: captured.restrictedTools, prompt: "", tools: [],
    call: async () => { throw new Error("The bot turn requires its own tool credential."); },
  };
}
