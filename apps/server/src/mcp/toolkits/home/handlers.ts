import * as NodeCrypto from "node:crypto";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { HomeToolkit } from "./tools.ts";

export const HomeToolkitHandlersLive = HomeToolkit.toLayer(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    return HomeToolkit.of({
      list_chat_projects: () =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext;
          if (!scope.capabilities.has("agents"))
            return yield* Effect.fail("Project routing is unavailable for this session.");
          return (yield* snapshots.getProjectShells()).map(({ id, title, workspaceRoot }) => ({
            id,
            title,
            workspaceRoot,
          }));
        }).pipe(Effect.catchCause((cause) => Effect.fail(Cause.pretty(cause)))),
      handoff_to_project: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext;
          if (!scope.capabilities.has("agents"))
            return yield* Effect.fail("Project routing is unavailable for this session.");
          const parent = yield* snapshots.getThreadShellById(scope.threadId);
          const project = yield* snapshots.getProjectShellById(input.projectId);
          if (Option.isNone(parent) || Option.isNone(project))
            return yield* Effect.fail("The source chat or destination project is unavailable.");
          const digest = NodeCrypto.createHash("sha256")
            .update(`${scope.threadId}:${input.requestId}`)
            .digest("hex")
            .slice(0, 32);
          const threadId = ThreadId.make(`j1-handoff-${digest}`);
          const sourceUrl = `/${encodeURIComponent(scope.environmentId)}/${encodeURIComponent(scope.threadId)}`;
          const url = `/${encodeURIComponent(scope.environmentId)}/${encodeURIComponent(threadId)}`;
          const fingerprintHash = NodeCrypto.createHash("sha256");
          for (const value of [input.projectId, input.title, input.request])
            fingerprintHash.update(String(value.length)).update(":").update(value);
          const fingerprint = fingerprintHash.digest("hex");
          const legacyText = `Request handed off from [the source conversation](${sourceUrl}). Work in this project's workspace and follow its instructions.\n\n${input.request}`;
          const homeText = `## ${input.title}\n\n${input.request}\n\n[View the conversation in Home](${sourceUrl})`;
          const text = `## ${input.title}\n\n${input.request}\n\n[View source conversation](${sourceUrl})`;
          const existing = yield* snapshots.getThreadShellById(threadId);
          const now = DateTime.formatIso(yield* DateTime.now);
          if (Option.isSome(existing)) {
            const detail = yield* snapshots.getThreadDetailById(threadId);
            const receipt = Option.isSome(detail)
              ? detail.value.activities.find(
                  (activity) => activity.id === `handoff-receipt:${digest}`,
                )?.payload
              : null;
            if (
              existing.value.projectId !== input.projectId ||
              (typeof receipt === "object" &&
                receipt !== null &&
                "fingerprint" in receipt &&
                receipt.fingerprint !== fingerprint) ||
              (Option.isSome(detail) &&
                detail.value.messages.some(
                  (message) =>
                    message.id === `handoff-request:${digest}` &&
                    message.text !== text &&
                    message.text !== homeText &&
                    message.text !== legacyText,
                ))
            ) {
              return yield* Effect.fail("That requestId belongs to a different handoff.");
            }
          } else {
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`handoff-create:${digest}`),
              threadId,
              projectId: input.projectId,
              title: input.title,
              modelSelection: parent.value.modelSelection,
              runtimeMode: parent.value.runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: now,
            });
          }
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`handoff-receipt:${digest}`),
            threadId,
            createdAt: now,
            activity: {
              id: EventId.make(`handoff-receipt:${digest}`),
              kind: "home.handoff",
              summary: "Request received from Home",
              createdAt: now,
              tone: "info",
              turnId: null,
              payload: { fingerprint, sourceThreadId: scope.threadId, sourceUrl, url },
            },
          });
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`handoff-start:${digest}`),
            threadId,
            message: {
              messageId: MessageId.make(`handoff-request:${digest}`),
              role: "user",
              attachments: [],
              text,
            },
            modelSelection: parent.value.modelSelection,
            runtimeMode: parent.value.runtimeMode,
            interactionMode: "default",
            createdAt: now,
          });
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`handoff-source:${digest}`),
            threadId: scope.threadId,
            createdAt: now,
            activity: {
              id: EventId.make(`handoff-source:${digest}`),
              kind: "home.handoff",
              summary: `Handed off: ${input.title}`,
              createdAt: now,
              tone: "info",
              turnId: null,
              payload: { fingerprint, threadId, projectId: input.projectId, url },
            },
          });
          return {
            threadId,
            url,
          };
        }).pipe(Effect.catchCause((cause) => Effect.fail(Cause.pretty(cause)))),
    });
  }),
);
