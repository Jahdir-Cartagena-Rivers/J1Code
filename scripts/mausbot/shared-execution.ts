// Copied into the captured runtime. Provider accounts and agent processes stay
// in J1; the original bot harness retains its tool scopes, approvals and UI.
import * as NodeCrypto from "node:crypto";
import type { ModelCatalog, ProviderDriver, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { newEventId } from "../contracts.ts";
import { mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";
import { createChatToolApproval, refusal } from "./chat-tool-approval.ts";
import {
  sharedExecutionRequest,
  sharedCatalog as catalog,
  onSharedExecution,
  sharedObject as object,
  type SharedObject as ObjectValue,
} from "./j1-shared-client.ts";
export { sharedExecutionRequest } from "./j1-shared-client.ts";
export { encodeSharedModel } from "../j1-shared-selection.ts";
import { encodeSharedModel } from "../j1-shared-selection.ts";

type EventInput<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, "eventId" | "provider" | "threadId" | "createdAt">
  : never;
export function decodeSharedModel(value: string) {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1)
    throw new Error("Select an account and model from J1's shared catalog.");
  return {
    instanceId: decodeURIComponent(value.slice(0, separator)),
    model: decodeURIComponent(value.slice(separator + 1)),
  };
}

type Turn = {
  input: SendTurnInput;
  turnId: string;
  controller: AbortController;
  tools: ChatToolSession;
  approvals: ReturnType<typeof createChatToolApproval>;
  questions: Map<string, string[]>;
  assistant: Map<string, string>;
  sessionAnnounced: boolean;
  sent: boolean;
  errorReported: boolean;
  toolCalls: Map<string, AbortController>;
};

export const J1SharedDriver: ProviderDriver<Record<string, never>> = {
  driverKind: "j1-shared",
  metadata: {
    displayName: "J1 shared providers",
    supportsMultipleInstances: false,
    access: "subscription",
  },
  models: { default: "", options: [] },
  defaultConfig: () => ({}),
  decodeConfig(raw) {
    if (!object(raw) || Object.keys(raw).length)
      throw new Error("Configure these provider accounts in J1's Model providers settings.");
    return {};
  },
  async create(input) {
    const events = new Set<(event: RuntimeEvent) => void>();
    const turns = new Map<string, Turn>();
    const models: ModelCatalog = { default: "", options: [] };
    const emit = (threadId: string, value: EventInput) => {
      const event = {
        eventId: newEventId(),
        provider: "j1-shared",
        providerInstanceId: input.instanceId,
        threadId,
        createdAt: new Date().toISOString(),
        ...value,
      } as RuntimeEvent;
      for (const listener of events) listener(event);
    };
    const cleanup = async (threadId: string) => {
      const turn = turns.get(threadId);
      if (!turn) return;
      turns.delete(threadId);
      turn.controller.abort();
      turn.approvals.close();
      await turn.tools.close();
    };
    const source = (turn: Turn) => ({ botId: turn.input.botId, threadId: turn.input.threadId });
    const onBridgeEvent = (message: ObjectValue) => {
      if (message.kind === "catalog") {
        void refreshModels().catch(() => {});
        return;
      }
      if (message.kind === "disconnected") {
        for (const [threadId, turn] of turns) {
          emit(threadId, {
            type: "runtime.error",
            turnId: turn.turnId,
            message: "J1 disconnected; this conversation can be resumed.",
            terminal: true,
          });
          emit(threadId, {
            type: "turn.completed",
            turnId: turn.turnId,
            ok: false,
            stopReason: "J1 disconnected; this conversation can be resumed.",
          });
          void cleanup(threadId);
        }
        return;
      }
      if (typeof message.threadId !== "string") return;
      const turn = turns.get(message.threadId);
      if (!turn || turn.input.botId !== message.botId) return;
      if (message.kind === "tool-cancel" && typeof message.requestId === "string") {
        turn.toolCalls.get(message.requestId)?.abort();
        return;
      }
      if (message.kind === "tool-call") {
        if (typeof message.requestId !== "string" || turn.toolCalls.has(message.requestId)) return;
        const requestId = message.requestId;
        const controller = new AbortController();
        const stop = () => controller.abort();
        turn.controller.signal.addEventListener("abort", stop, { once: true });
        if (turn.controller.signal.aborted) controller.abort();
        turn.toolCalls.set(requestId, controller);
        void (async () => {
          let value: unknown;
          try {
            if (typeof message.name !== "string" || !object(message.arguments))
              throw new Error("Invalid tool call.");
            turn.tools.validate(message.name, message.arguments);
            const shown = turn.tools.view(message.name, message.arguments);
            const full = (turn.input.approvalModeNow?.() ?? turn.input.approvalMode) === "full";
            const block = turn.approvals.floored({
              full,
              threadId: turn.input.threadId,
              botId: turn.input.botId,
              shown,
            });
            const allowed =
              !block &&
              (full ||
                !shown.ask ||
                (await turn.approvals.ask(shown.title, JSON.stringify(shown.input), shown.grant)));
            if (controller.signal.aborted) throw new Error("The bot tool was cancelled.");
            value = allowed
              ? await turn.tools.execute(message.name, message.arguments, controller.signal)
              : { ok: false, text: refusal(block, () => {}) };
          } catch (error) {
            value = { ok: false, text: String(error) };
          } finally {
            turn.toolCalls.delete(requestId);
            turn.controller.signal.removeEventListener("abort", stop);
          }
          await sharedExecutionRequest({
            action: "tool-result",
            ...source(turn),
            requestId: message.requestId,
            value,
          });
        })().catch(() => {});
        return;
      }
      if (message.kind === "failed") {
        emit(turn.input.threadId, {
          type: "runtime.error",
          turnId: turn.turnId,
          message: String(message.message),
          setup: true,
          terminal: true,
        });
        emit(turn.input.threadId, {
          type: "turn.completed",
          turnId: turn.turnId,
          ok: false,
          stopReason: String(message.message),
        });
        void cleanup(turn.input.threadId);
        return;
      }
      const event = message.event;
      if (!object(event) || !object(event.payload)) return;
      const payload = event.payload;
      const base = {
        turnId: turn.turnId,
        ...(typeof event.itemId === "string" ? { itemId: event.itemId } : {}),
        ...(typeof event.requestId === "string" ? { requestId: event.requestId } : {}),
      };
      const send = (value: object) =>
        emit(turn.input.threadId, { ...base, ...value } as RuntimeEvent);
      const announce = () => {
        if (turn.sessionAnnounced) return;
        turn.sessionAnnounced = true;
        send({
          type: "session.started",
          sessionId: `j1-shared:${turn.input.botId}:${turn.input.threadId}`,
          model: turn.input.model,
        });
      };
      const assistantKey = typeof event.itemId === "string" ? event.itemId : "assistant";
      switch (event.type) {
        case "runtime.error":
          turn.errorReported = true;
          send({
            type: "runtime.error",
            message:
              typeof payload.message === "string"
                ? payload.message
                : "The shared provider reported an error.",
          });
          break;
        case "session.started":
          announce();
          break;
        case "turn.started":
          announce();
          if (!turn.sent) {
            turn.sent = true;
            turn.input.onInputSent?.(turn.turnId);
          }
          send({ type: "turn.started" });
          break;
        case "content.delta":
          if (payload.streamKind === "assistant_text" && typeof payload.delta === "string")
            turn.assistant.set(
              assistantKey,
              (turn.assistant.get(assistantKey) ?? "") + payload.delta,
            );
          if (payload.streamKind === "assistant_text" || payload.streamKind === "reasoning_text")
            send({ type: "content.delta", streamKind: payload.streamKind, delta: payload.delta });
          break;
        case "item.started":
          if (payload.itemType !== "assistant_message")
            send({
              type: "item.started",
              itemType: payload.itemType === "reasoning" ? "reasoning" : "tool",
              title: payload.title ?? payload.itemType,
            });
          break;
        case "item.completed":
          if (payload.itemType === "assistant_message") {
            const text =
              turn.assistant.get(assistantKey) ??
              (object(payload.data) && typeof payload.data.text === "string"
                ? payload.data.text
                : typeof payload.detail === "string"
                  ? payload.detail
                  : "");
            turn.assistant.delete(assistantKey);
            if (text) send({ type: "item.completed", itemType: "assistant_text", text });
          } else if (payload.itemType !== "reasoning")
            send({
              type: "item.completed",
              itemType: "tool",
              ok: payload.status !== "failed",
              output: payload.detail,
            });
          break;
        case "request.opened":
          send({
            type: "request.opened",
            requestType: "permission",
            tool: payload.appName ?? payload.requestType,
            summary: payload.detail ?? "The shared provider requests permission.",
            input: payload.args ?? {},
            requiresExplicitApproval: true,
          });
          break;
        case "user-input.requested": {
          const questions = Array.isArray(payload.questions)
            ? payload.questions.filter(object)
            : [];
          if (typeof event.requestId === "string")
            turn.questions.set(
              event.requestId,
              questions.map((q) => String(q.id)),
            );
          send({
            type: "request.opened",
            requestType: "question",
            tool: "AskUserQuestion",
            summary: "The shared provider has a question.",
            questions: questions.map((q) => ({
              question: q.question,
              header: q.header,
              options: q.options,
              multiSelect: q.multiSelect,
            })),
            input: {},
          });
          break;
        }
        case "request.resolved":
        case "user-input.resolved":
          send({
            type: "request.resolved",
            behavior:
              event.type === "user-input.resolved"
                ? "answer"
                : payload.decision === "decline"
                  ? "deny"
                  : "allow",
            source: "user",
          });
          break;
        case "turn.completed":
        case "turn.aborted":
        case "session.exited":
          for (const [itemId, text] of turn.assistant) {
            if (text)
              send({
                type: "item.completed",
                itemType: "assistant_text",
                itemId: itemId === "assistant" ? undefined : itemId,
                text,
              });
          }
          turn.assistant.clear();
          if (
            (event.type === "session.exited" ||
              (event.type === "turn.completed" && payload.state === "failed")) &&
            !turn.errorReported
          )
            send({
              type: "runtime.error",
              message:
                payload.errorMessage ??
                (event.type === "session.exited"
                  ? "The shared provider session ended before the turn completed."
                  : "The shared provider turn failed."),
              terminal: true,
            });
          send({
            type: "turn.completed",
            ok:
              event.type === "turn.completed" &&
              payload.state !== "failed" &&
              payload.state !== "interrupted",
            stopReason: payload.errorMessage ?? payload.reason ?? payload.stopReason,
            cost: payload.totalCostUsd,
            ...(object(payload.tokenUsage)
              ? {
                  usage: {
                    input: payload.tokenUsage.inputTokens ?? 0,
                    output: payload.tokenUsage.outputTokens ?? 0,
                    cachedInput: payload.tokenUsage.cachedInputTokens,
                  },
                }
              : {}),
          });
          void cleanup(turn.input.threadId);
          break;
      }
    };
    const removeBridgeListener = onSharedExecution(onBridgeEvent);
    const refreshModels = async () => {
      const rows = (await catalog()).filter((row) => row.enabled);
      models.options = rows.flatMap((row) =>
        row.models.map((model) => ({
          id: encodeSharedModel(row.instanceId, model.slug),
          label: `${model.name} · ${row.displayName ?? row.driver}`,
          variants: model.capabilities?.optionDescriptors
            ?.find((option) => option.id === "variant")
            ?.options?.map((option) => ({ id: option.id, label: option.label })),
        })),
      );
      models.default = models.options[0]?.id ?? "";
    };
    return {
      instanceId: input.instanceId,
      driverKind: "j1-shared",
      displayName: input.displayName,
      enabled: input.enabled,
      models,
      refreshModels,
      startupModelRefresh: refreshModels(),
      async snapshot() {
        try {
          const ready = (await catalog()).some(
            (row) => row.enabled && row.installed && row.auth.status !== "unauthenticated",
          );
          return ready
            ? { state: "available", authenticated: true }
            : {
                state: "unavailable",
                authenticated: false,
                reason: "Connect a provider account in J1's Model providers settings.",
              };
        } catch {
          return {
            state: "unavailable",
            authenticated: false,
            reason: "J1's shared execution connection is unavailable.",
          };
        }
      },
      adapter: {
        provider: "j1-shared",
        capabilities: {
          sessionModelSwitch: "unsupported",
          agentsMcp: true,
          computerMcp: true,
          localComputerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          browserMcp: true,
          dataMcp: true,
          emailMcp: true,
          deviceMcp: true,
          customMcp: true,
          images: true,
          nativeImageInput: true,
          strictResume: true,
          engineAdmission: true,
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        async sendTurn(turnInput) {
          if (!turnInput.botId)
            throw new Error("Shared execution requires the original bot identity.");
          if (turns.has(turnInput.threadId))
            throw new Error("This bot conversation is already running.");
          if (turnInput.guestConfined)
            throw new Error("Shared execution is unavailable to guest turns.");
          if (turnInput.approvalMode === "custom")
            throw new Error("Select a supported J1 permission mode before using shared execution.");
          if (
            [...(turnInput.toolScope?.allow ?? []), ...(turnInput.toolScope?.deny ?? [])].some(
              (selector) => selector.startsWith("native:"),
            )
          )
            throw new Error(
              "This bot has native-tool restrictions that its selected shared provider cannot yet enforce. Its existing engine and permissions are preserved.",
            );
          const selected = decodeSharedModel(turnInput.model ?? models.default);
          await turnInput.engineAdmission?.("session");
          const controller = new AbortController();
          const tools = await mountChatTools(
            turnInput.integrations,
            controller.signal,
            true,
            turnInput.toolScope,
            turnInput.mcpCallTimeoutMs,
            undefined,
            turnInput.toolResultFolder,
          );
          const turnId = NodeCrypto.randomUUID();
          const approvals = createChatToolApproval({
            signal: controller.signal,
            open: (ask) =>
              emit(turnInput.threadId, {
                type: "request.opened",
                turnId,
                requestId: ask.id,
                requestType: "permission",
                tool: ask.tool,
                summary: ask.summary,
              }),
            resolved: (ask, allowed, source) =>
              emit(turnInput.threadId, {
                type: "request.resolved",
                turnId,
                requestId: ask.id,
                behavior: allowed ? "allow" : "deny",
                source,
              }),
            openQuestion: (ask, questions) =>
              emit(turnInput.threadId, {
                type: "request.opened",
                turnId,
                requestId: ask.id,
                requestType: "question",
                tool: ask.tool,
                summary: ask.summary,
                questions,
              }),
            resolvedQuestion: (ask, answered, source) =>
              emit(turnInput.threadId, {
                type: "request.resolved",
                turnId,
                requestId: ask.id,
                behavior: answered ? "answer" : "deny",
                source,
              }),
          });
          const turn: Turn = {
            input: turnInput,
            turnId,
            controller,
            tools,
            approvals,
            questions: new Map(),
            assistant: new Map(),
            sessionAnnounced: false,
            sent: false,
            errorReported: false,
            toolCalls: new Map(),
          };
          turns.set(turnInput.threadId, turn);
          try {
            const result = await sharedExecutionRequest({
              action: "start",
              ...source(turn),
              ...selected,
              botName: turnInput.j1BotName ?? "Bot",
              title: turnInput.j1BotName ?? "Bot conversation",
              ...(turnInput.j1ProjectId ? { projectId: turnInput.j1ProjectId } : {}),
              cwd: turnInput.cwd ?? process.cwd(),
              text: turnInput.text,
              system: turnInput.system ?? "",
              turnId,
              sharedContinuation:
                typeof turnInput.resumeCursor === "string" &&
                turnInput.resumeCursor.startsWith("j1-shared:"),
              restrictedTools: turnInput.toolScope !== undefined,
              ...(turnInput.transcript ? { transcript: turnInput.transcript } : {}),
              ...(turnInput.recoveryText
                ? { recoveryText: turnInput.recoveryText }
                : turnInput.transcript?.length
                  ? {
                      recoveryText: turnInput.transcript
                        .map((m) => `${m.role}: ${m.text}`)
                        .join("\n\n"),
                    }
                  : {}),
              ...(turnInput.effort ? { effort: turnInput.effort } : {}),
              ...(turnInput.variant ? { variant: turnInput.variant } : {}),
              approvalMode: turnInput.approvalModeNow?.() ?? turnInput.approvalMode ?? "ask",
              guestConfined: false,
              images: turnInput.images ?? [],
              tools: tools.definitions.map(({ function: fn }) => ({
                name: fn.name,
                description: fn.description,
                inputSchema: fn.parameters,
              })),
            });
            if (!object(result) || typeof result.turnId !== "string")
              throw new Error("J1 did not accept the bot turn.");
            turn.turnId = result.turnId;
            return { turnId: result.turnId };
          } catch (error) {
            await cleanup(turnInput.threadId);
            throw error;
          }
        },
        async interruptTurn(threadId) {
          const turn = turns.get(threadId);
          if (turn) {
            turn.controller.abort();
            turn.approvals.close();
            await sharedExecutionRequest({ action: "interrupt", ...source(turn) });
          }
        },
        async respondToRequest(threadId, requestId, decision) {
          const turn = turns.get(threadId);
          if (!turn) return "unavailable";
          const local = turn.approvals.answer(requestId, decision.behavior, decision.message);
          if (local !== "unavailable") return local;
          if (decision.behavior === "answer") {
            const ids = turn.questions.get(requestId);
            if (!ids || !decision.message?.trim()) return "unavailable";
            await sharedExecutionRequest({
              action: "answer",
              ...source(turn),
              requestId,
              answers: Object.fromEntries(ids.map((id) => [id, decision.message])),
            });
            return "answered";
          }
          await sharedExecutionRequest({
            action: "respond",
            ...source(turn),
            requestId,
            decision: decision.behavior === "allow" ? "accept" : "decline",
          });
          return decision.behavior === "allow" ? "allowed-once" : "rejected";
        },
        hasSession: (threadId) => turns.has(threadId),
        async stopAll() {
          await Promise.all(
            [...turns].map(async ([threadId, turn]) => {
              turn.controller.abort();
              turn.approvals.close();
              await sharedExecutionRequest({ action: "stop", ...source(turn) }).finally(() =>
                cleanup(threadId),
              );
            }),
          );
        },
        onEvent(listener) {
          events.add(listener);
          return () => events.delete(listener);
        },
      },
      async dispose() {
        removeBridgeListener();
        await Promise.all(
          [...turns].map(async ([threadId, turn]) => {
            turn.controller.abort();
            turn.approvals.close();
            await sharedExecutionRequest({ action: "stop", ...source(turn) }).finally(() =>
              cleanup(threadId),
            );
          }),
        );
        events.clear();
      },
    };
  },
};
