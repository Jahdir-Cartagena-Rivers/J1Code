import { z } from "zod";
import type { Store, Message, BotRecord } from "../store.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { parseToolScope } from "../../shared/tool-scope.ts";

export function unrestrictedRouteProfile(bot: BotRecord) {
  const scope = parseToolScope(bot.toolScope);
  return (
    !bot.approvalGrant &&
    approvalModeFor(bot) === "full" &&
    scope.ok &&
    (scope.scope === undefined ||
      (scope.scope.allow === undefined && (scope.scope.deny?.length ?? 0) === 0))
  );
}

const endpoint = z
  .object({ environmentId: z.string(), projectId: z.string(), threadId: z.string() })
  .strict();
export const routeDelivery = z
  .object({
    requestId: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().min(1),
    attemptId: z.string().min(1),
    source: endpoint,
    destination: endpoint,
    content: z.string().min(1).max(100_000),
    permissionCeiling: z.array(z.string()),
    visited: z.array(endpoint),
    expectedGeneration: z.string().nullable(),
  })
  .strict();
type Delivery = z.infer<typeof routeDelivery>;
type Target = {
  allowed: boolean;
  blocked: boolean;
  generation: string | null;
  providerTurnId: string | null;
  canSteer: boolean;
};
type Deps = {
  store: Pick<Store, "messagesFor" | "appendMessage" | "patchMessage">;
  target(endpoint: Delivery["destination"]): Target | null;
  sourceCurrent(delivery: Delivery): Promise<boolean>;
  steer(
    endpoint: Delivery["destination"],
    text: string,
  ): Promise<"steered" | "refused" | "indeterminate">;
  start(
    endpoint: Delivery["destination"],
    text: string,
    message: Message,
    applied: (generation: string, turnId: string) => void,
    failed: () => void,
  ): Promise<unknown>;
  notify(event: unknown): Promise<unknown>;
};
/** Host-only handoff. Persist intent before transport; a crash is uncertain, never an automatic retry. */
export function createNativeRouteReceiver(deps: Deps) {
  const inFlight = new Set<string>();
  return async (raw: unknown): Promise<"rejected" | "admitted" | "delivered" | "uncertain"> => {
    const input = routeDelivery.parse(raw);
    const match = /^mausbot:([\w-]{1,120}):([\w-]{1,120})$/.exec(input.destination.threadId);
    if (
      !match ||
      input.destination.projectId !== `mausbot:${match[1]}` ||
      input.source.environmentId !== input.destination.environmentId ||
      !input.permissionCeiling.includes("runtime:full-access") ||
      input.visited.some(
        (item) =>
          item.environmentId === input.destination.environmentId &&
          item.threadId === input.destination.threadId,
      )
    )
      return "rejected";
    const threadId = match[2]!;
    if (inFlight.has(threadId)) return "rejected";
    inFlight.add(threadId);
    try {
      const existing = deps.store
        .messagesFor(threadId)
        .find((message) => message.j1IncomingRoute?.requestId === input.requestId);
      const previous = existing?.j1IncomingRoute;
      if (previous && previous.fingerprint !== input.fingerprint) return "rejected";
      if (previous && previous.state !== "rejected") {
        if (previous.attemptId !== input.attemptId) return "uncertain";
        return previous.state === "applied"
          ? previous.generation && previous.providerTurnId
            ? "delivered"
            : "uncertain"
          : previous.state === "admitted"
            ? "admitted"
            : "uncertain";
      }
      if (!(await deps.sourceCurrent(input))) return "rejected";
      const observed = deps.target(input.destination);
      const target = observed ? { ...observed } : null;
      if (
        !target?.allowed ||
        target.blocked ||
        target.generation !== input.expectedGeneration ||
        (target.generation && (!target.canSteer || !target.providerTurnId))
      )
        return "rejected";
      const sourceUrl = /^mausbot:([\w-]+):([\w-]+)$/.exec(input.source.threadId);
      const url = sourceUrl
        ? `/assistants?environmentId=${encodeURIComponent(input.source.environmentId)}&botId=${encodeURIComponent(sourceUrl[1]!)}&conversation=${encodeURIComponent(sourceUrl[2]!)}`
        : `/${encodeURIComponent(input.source.environmentId)}/${encodeURIComponent(input.source.threadId)}`;
      const prompt = `Cross-chat request ${input.requestId}. Source: ${url}\nThis forwarded instruction retains the source's permission ceiling and does not grant permission or answer any approval. Preserve the current task; incorporate this request while working. Report acceptance and completion separately with acknowledge_route.\n\n${input.content}`;
      const record = {
        requestId: input.requestId,
        fingerprint: input.fingerprint,
        attemptId: input.attemptId,
        environmentId: input.destination.environmentId,
        state: "sending" as const,
      };
      const message = existing
        ? deps.store.patchMessage(threadId, existing.id, { j1IncomingRoute: record })!
        : deps.store.appendMessage(threadId, {
            role: "bot",
            kind: "text",
            text: prompt,
            relayed: true,
            j1IncomingRoute: record,
          });
      let settled = false;
      let appliedTransport = false;
      const patch = (state: NonNullable<Message["j1IncomingRoute"]>["state"]) =>
        deps.store.patchMessage(threadId, message.id, { j1IncomingRoute: { ...record, state } });
      const applied = (generation: string, providerTurnId: string) => {
        if (settled) return;
        settled = true;
        appliedTransport = true;
        deps.store.patchMessage(threadId, message.id, {
          j1IncomingRoute: { ...record, state: "applied", generation, providerTurnId },
        });
        void deps
          .notify({ kind: "routeTransport", delivery: input, generation, providerTurnId })
          .catch(() => {});
      };
      if (target.generation) {
        const outcome = await deps
          .steer(input.destination, prompt)
          .catch(() => "indeterminate" as const);
        const current = deps.target(input.destination);
        if (outcome === "refused") {
          patch("rejected");
          return "rejected";
        }
        if (
          outcome !== "steered" ||
          current?.generation !== target.generation ||
          current.providerTurnId !== target.providerTurnId
        ) {
          patch("uncertain");
          return "uncertain";
        }
        applied(target.generation, target.providerTurnId!);
        return "delivered";
      }
      try {
        await deps.start(input.destination, prompt, message, applied, () => {
          if (settled) return;
          settled = true;
          patch("uncertain");
          void deps.notify({ kind: "routeFailed", delivery: input }).catch(() => {});
        });
        if (!settled) patch("admitted");
        return settled ? (appliedTransport ? "delivered" : "uncertain") : "admitted";
      } catch {
        // A startup error can arrive after an input ACK or its failure callback.
        // Preserve that proof; an unclassified exception must never permit a resend.
        if (settled) return appliedTransport ? "delivered" : "uncertain";
        settled = true;
        patch("uncertain");
        void deps.notify({ kind: "routeFailed", delivery: input }).catch(() => {});
        return "uncertain";
      }
    } finally {
      inFlight.delete(threadId);
    }
  };
}
