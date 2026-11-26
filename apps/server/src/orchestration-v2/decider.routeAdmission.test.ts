import { expect, it } from "@effect/vitest";
import { OrchestrationV2Command, OrchestrationV2IdleRouteCommand } from "@j1code/contracts";
import * as Schema from "effect/Schema";

const command = {
  type: "thread.route.deliver-idle",
  commandId: "command:route-idle:receipt",
  messageId: "message:route-idle:receipt",
  runId: "route-idle-run",
  threadId: "destination",
  requestId: "request",
  attemptId: "attempt",
  environmentId: "environment",
  projectId: "destination-project",
  senderThreadId: "foreign-source",
  sourceProjectId: "foreign-project",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  activeProviderThreadId: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  policyFingerprint: "policy",
  authorityFingerprint: "native-authority",
  text: "Deliver after the recorded idle check.",
};

it("keeps trusted idle routes out of client dispatch and validates their complete identity", () => {
  const decodeInternal = Schema.decodeUnknownSync(OrchestrationV2IdleRouteCommand);
  const decodeClient = Schema.decodeUnknownSync(OrchestrationV2Command);
  expect(decodeInternal(command)).toEqual(command);
  expect(() => decodeClient(command)).toThrow();
  for (const field of [
    "commandId", "messageId", "runId", "requestId", "attemptId", "environmentId",
    "senderThreadId", "sourceProjectId", "modelSelection", "runtimeMode",
    "policyFingerprint", "authorityFingerprint",
  ] as const) {
    const incomplete: Partial<typeof command> = { ...command };
    delete incomplete[field];
    expect(() => decodeInternal(incomplete)).toThrow();
  }
  expect(decodeClient({
    type: "message.dispatch",
    commandId: "ordinary-command",
    messageId: "ordinary-message",
    dispatchMode: { type: "start_immediately" },
    threadId: command.threadId,
    createdBy: "user",
    creationSource: "web",
    text: command.text,
    attachments: [],
  })).toMatchObject({ type: "message.dispatch", messageId: "ordinary-message" });
});
