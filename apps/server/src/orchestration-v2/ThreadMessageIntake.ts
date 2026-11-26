import { remapComposerContextAttachments } from "@j1code/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import { AuthoredRequestFingerprint } from "./AutoModelRouting.ts";
import { strictSteerFingerprint } from "./ProviderTurnControlService.ts";
import type { ChatAttachment, OrchestrationV2Command } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// These failures precede commitCommand; generic dispatch errors can follow commits and remain ambiguous.
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorHomeThreadAlreadyExistsError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "OrchestratorProviderSelectionBusyError":
    case "OrchestratorRuntimeModeAboveCeilingError":
    case "ThreadManagementProviderInstanceDisabledError":
    case "ThreadManagementWorktreeRestoreError":
      return true;
    default:
      return false;
  }
}
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const isThreadManagementError = Schema.is(ThreadManagement.ThreadManagementError);

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.flatMap((attachment) => {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      return path ? [path, `${path}.txt`] : [];
    }),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

/**
 * A guest message goes out with the files the guest attached, never ones a client names. They
 * are already the thread's attachments. A message no longer waiting gets none; the orchestrator
 * then refuses or replays the send.
 */
const withGuestAttachments = Effect.fn("ThreadMessageIntake.withGuestAttachments")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
) {
  if (command.guestMessageId === undefined) return command;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Only the thread record is needed; the window keeps the read small.
  const { projection } = yield* threads
    .getThreadSnapshotWindow(command.threadId, { rowLimit: 1 })
    .pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentClaims.AttachmentClaimError({
            message: "Failed to read the guest message.",
            cause,
          }),
      ),
    );
  const message = projection.thread.guestShare?.messages.find(
    (candidate) => candidate.id === command.guestMessageId && candidate.status === "pending",
  );
  return { ...command, attachments: message?.attachments ?? [] };
});

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  incoming: OrchestrationV2Command,
) {
  yield* Orchestrator.validateLiveMessageCommand(incoming);
  const command =
    incoming.type === "message.dispatch" ? yield* withGuestAttachments(incoming) : incoming;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
    const fingerprint = strictSteerFingerprint(command);
    // A saved answer can replay after its pending upload has expired.
    if (yield* threads.hasReceipt(command.commandId)) {
      return yield* threads.dispatch(command).pipe(
        Effect.provideService(AuthoredRequestFingerprint, fingerprint),
      );
    }
    const config = yield* ServerConfig.ServerConfig;
    const incomingByQuestionId = command.attachmentsByQuestionId;
    yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
    const claimedPaths: string[] = [];
    const prepared = yield* Effect.gen(function* () {
      const attachmentsByQuestionId: import("@j1code/contracts").UserInputAttachments = {};
      for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: command.threadId,
          attachments,
        });
        claimedPaths.push(...claimed.claimedPaths);
        Object.defineProperty(attachmentsByQuestionId, questionId, {
          value: claimed.attachments,
          enumerable: true,
        });
      }
      const answers = yield* appendUserInputAttachmentPaths({
        answers: command.answers ?? {},
        attachmentsByQuestionId,
        attachmentsDir: config.attachmentsDir,
      }).pipe(
        Effect.mapError(
          (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
        ),
      );
      return { answers, attachmentsByQuestionId };
    }).pipe(Effect.onError(() => AttachmentClaims.releaseClaimedAttachments(claimedPaths)));
    return yield* threads
      .dispatch({
        ...command,
        answers: prepared.answers,
        attachmentsByQuestionId: prepared.attachmentsByQuestionId,
      })
      .pipe(
        Effect.provideService(AuthoredRequestFingerprint, fingerprint),
        Effect.tap((result) => {
          // Replayed receipts refer to the first answer; release this attempt's unused copies only with a resolved item.
          // Missing questionAnswer means no accepted attachments; missing resolution leaves delivery ambiguous.
          const answeredItems = result.storedEvents.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.requestId === command.requestId
              ? [event.payload]
              : [],
          );
          return answeredItems.length > 0
            ? releaseUnusedClaims(
                claimedPaths,
                answeredItems.flatMap((item) =>
                  item.questionAnswer === undefined
                    ? []
                    : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                ),
              )
            : Effect.void;
        }),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimedPaths)
            : Effect.void,
        ),
      );
  }
  if (
    command.type !== "message.dispatch" &&
    (command.type !== "queued-run.edit" || command.attachments === undefined)
  )
    return yield* threads.dispatch(command);
  // An accepted edit's retry replays its receipt even if a later cleanup removed its files.
  if (command.type === "queued-run.edit" && !(yield* threads.hasReceipt(command.commandId))) {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    // A stale view can keep a file that another client's edit dropped and deleted.
    for (const attachment of command.attachments ?? []) {
      if (AttachmentClaims.attachmentIsPendingUpload(attachment)) continue;
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (
        path !== null &&
        !(yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* new AttachmentClaims.AttachmentClaimError({
          message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
        });
      }
    }
  }
  const autoFingerprint = command.type === "message.dispatch" && command.autoRouting !== undefined
    ? strictSteerFingerprint(command)
    : undefined;
  // Exact replay needs the original submission, even after the pending upload has expired.
  if (autoFingerprint !== undefined && (yield* threads.hasReceipt(command.commandId))) {
    return yield* threads.dispatch(command).pipe(
      Effect.provideService(AuthoredRequestFingerprint, autoFingerprint),
    );
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: command.threadId,
    attachments: command.attachments ?? [],
  });
  return yield* threads
    .dispatch({
      ...command,
      attachments: claimed.attachments,
      ...(command.context
        ? {
            context: remapComposerContextAttachments(
              command.context,
              command.attachments ?? [],
              claimed.attachments,
            ),
          }
        : {}),
    })
    .pipe(
      Effect.provideService(AuthoredRequestFingerprint, autoFingerprint),
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.storedEvents.flatMap(({ event }) =>
            event.type === "message.updated" ? event.payload.attachments : [],
          ),
        ),
      ),
      Effect.tapError((error) =>
        dispatchWasNotAccepted(error)
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void,
      ),
    );
});

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  yield* Orchestrator.validateLiveMessageId(input.commandId, "message.dispatch", input.messageId);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  return yield* threads.sendToThread({ ...input, attachments: claimed.attachments }).pipe(
    Effect.tap((result) => releaseUnusedClaims(claimed.claimedPaths, result.message.attachments)),
    Effect.tapError((error) =>
      dispatchWasNotAccepted(error)
        ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
        : Effect.void,
    ),
  );
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  input: ThreadLaunch.ThreadLaunchInput,
) {
  yield* Orchestrator.validateLiveMessageId(
    input.commandId,
    "message.dispatch",
    input.initialMessage?.messageId,
  );
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const auto = input.autoRouting !== undefined || input.initialMessage?.autoRouting !== undefined;
  const fingerprint = auto || (input.reuseExistingThread === true && input.initialMessage !== undefined)
    ? strictSteerFingerprint(input)
    : undefined;
  const launch = (request: ThreadLaunch.ThreadLaunchInput) => launches.launch(request).pipe(
    Effect.provideService(AuthoredRequestFingerprint, fingerprint),
  );
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  const hasPendingAttachments =
    input.initialMessage?.attachments.some(AttachmentClaims.attachmentIsPendingUpload) === true;
  if (auto || (hasPendingAttachments && fingerprint !== undefined)) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    if (yield* threads.hasReceipt(input.commandId)) {
      if (auto) return yield* launch(input);
      if (input.threadId !== undefined) {
        // A legacy draft can have a metadata receipt without an accepted first message.
        const records = yield* threads.getThreadRecords(input.threadId, ["runs"]).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (records?.runs.some((run) => run.draftLaunchFingerprint === fingerprint))
          return yield* launch(input);
      }
    }
  }
  if (!hasPendingAttachments || input.initialMessage === undefined) {
    return yield* launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  return yield* launch({
    ...input,
    initialMessage: {
      ...input.initialMessage,
      attachments: claimed.attachments,
      ...(input.initialMessage.context
        ? {
            context: remapComposerContextAttachments(
              input.initialMessage.context,
              input.initialMessage.attachments,
              claimed.attachments,
            ),
          }
        : {}),
    },
  }).pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ),
      ),
      Effect.tapError((error) => {
        if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Project/receipt reads precede dispatch; create-thread errors can wrap post-message reads and prove nothing alone.
        const notAccepted =
          error.bootstrapThreadDisposition === "not-created" ||
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          ((error.operation === "create-thread" || error.operation === "dispatch-message") &&
            (isOrchestratorError(error.cause) || isThreadManagementError(error.cause)) &&
            // Projection errors under create-thread can occur after the message commit.
            (error.operation !== "create-thread" ||
              error.cause._tag !== "OrchestratorProjectionError") &&
            dispatchWasNotAccepted(error.cause));
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void;
      }),
    );
});
