import type { ThreadId } from "@j1code/contracts";

export interface BotExecutionContext {
  readonly restrictedTools: boolean;
  readonly prompt: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema: unknown;
  }>;
  readonly call: (name: string, arguments_: unknown, signal: AbortSignal) => Promise<unknown>;
}

// Only the captured child bridge can register a turn. Nothing crossing the
// public API may supply a context or borrow another bot's tool connection.
const contexts = new Map<ThreadId, BotExecutionContext>();

export function registerBotExecutionContext(threadId: ThreadId, context: BotExecutionContext) {
  if (contexts.has(threadId)) throw new Error("This bot thread already has an active turn.");
  contexts.set(threadId, context);
  return () => {
    if (contexts.get(threadId) === context) contexts.delete(threadId);
  };
}

export const botExecutionContext = (threadId: ThreadId) => contexts.get(threadId);
