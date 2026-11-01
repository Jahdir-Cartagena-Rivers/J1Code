import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  AutoRoutingRequest,
  ClientOrchestrationCommand,
  ThreadTurnStartCommand,
  ThreadTurnStartRequestedPayload,
} from "./orchestration.ts";

const decodeAuto = Schema.decodeUnknownSync(AutoRoutingRequest);
const decodeClient = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeStart = Schema.decodeUnknownSync(ThreadTurnStartCommand);
const decodePayload = Schema.decodeUnknownSync(ThreadTurnStartRequestedPayload);
const encodePayload = Schema.encodeSync(ThreadTurnStartRequestedPayload);

const command = {
  type: "thread.turn.start",
  commandId: "command-1",
  threadId: "thread-1",
  message: { messageId: "message-1", role: "user", text: "hello", attachments: [] },
  modelSelection: { instanceId: "codex", model: "auto" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-11-01T00:00:00.000Z",
};

it("decodes unchanged manual clients, including provider-native auto", () => {
  for (const decode of [decodeStart, decodeClient]) {
    const decoded = decode(command);
    expect(decoded).toEqual(command);
    expect(decoded).not.toHaveProperty("autoRouting");
  }
});
it("roundtrips explicit intent through client, server, and durable turn payload", () => {
  const autoRouting = { taskId: "stable-task:1", requestEscalation: true };
  const wire = { ...command, autoRouting };
  const decoded = decodeClient(wire);
  expect(decodeStart(JSON.parse(JSON.stringify(decoded)))).toEqual(wire);
  const payload = decodePayload({
    ...command,
    messageId: "message-1",
    autoRouting,
  });
  const encoded = encodePayload(payload);
  expect(decodePayload(JSON.parse(JSON.stringify(encoded))).autoRouting).toEqual(autoRouting);
});
it("rejects malformed identity and missing or invalid escalation intent", () => {
  for (const autoRouting of [
    null,
    {},
    { taskId: "a" },
    { taskId: "", requestEscalation: false },
    { taskId: "a".repeat(101), requestEscalation: false },
    { taskId: " task", requestEscalation: false },
    { taskId: "a/b", requestEscalation: false },
    { taskId: "a", requestEscalation: "yes" },
  ]) {
    expect(() => decodeAuto(autoRouting)).toThrow();
    expect(() => decodeClient({ ...command, autoRouting })).toThrow();
  }
});
