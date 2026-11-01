import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  MessageId,
  CommandId,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import { encodeQueuedThreadMessage, decodeQueuedThreadMessage } from "./thread-outbox-model";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";

const message = {
  environmentId: EnvironmentId.make("e"),
  threadId: ThreadId.make("t"),
  messageId: MessageId.make("m"),
  commandId: CommandId.make("c"),
  text: "Rewrite a paragraph",
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "configured" },
  createdAt: "2026-11-01T00:00:00.000Z",
};
it("retains explicit Auto across durable queue encoding while legacy entries remain manual", () => {
  expect(
    decodeQueuedThreadMessage(encodeQueuedThreadMessage({ ...message, autoRouting: true }))
      .autoRouting,
  ).toBe(true);
  expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(message)).autoRouting).toBeUndefined();
});
it("omits the manual turn override for Auto but preserves bootstrap identity and attachments", () => {
  const spec = {
    ...message,
    threadId: "t",
    commandId: "c",
    messageId: "m",
    projectId: ProjectId.make("p"),
    projectCwd: "/work",
    uploadedAttachments: [],
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    workspaceMode: "local" as const,
    branch: null,
    worktreePath: null,
    startFromOrigin: false,
    worktreeBranchName: "unused",
  };
  const auto = buildProjectThreadStartTurnInput({ ...spec, autoRouting: true });
  expect(auto).not.toHaveProperty("modelSelection");
  expect(auto).toHaveProperty("autoRouting", { taskId: "t", requestEscalation: false });
  expect(auto.bootstrap.createThread.modelSelection).toEqual(message.modelSelection);
  expect(auto.runtimeMode).toBe("approval-required");
  expect(buildProjectThreadStartTurnInput(spec)).toHaveProperty(
    "modelSelection",
    message.modelSelection,
  );
});
