import {
  EventId,
  OrchestrationV2RpcSchemas,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import { describe, expect, it } from "vite-plus/test";

import { shouldPublishShellApplicationEvent, toShellApplicationEvent } from "./ShellStream.ts";
import { projectDomainEventForWire, projectTurnItemForDetail } from "./WireProjection.ts";

const OUTPUT_BYTES_PER_ROW = 8_192;
const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-perf");

const PRE_OMISSION_COMMAND_EVENT_RPC_JSON_BYTES = 8_790;
const MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES = 1_024;

const encodeThreadStreamItem = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output),
);

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function encodedThreadStreamChunkBytes(value: OrchestrationV2ThreadStreamItem): number {
  const response = {
    _tag: "Chunk",
    requestId: 0,
    values: [encodeThreadStreamItem(value)],
  } satisfies RpcMessage.ResponseChunkEncoded;
  return encodedBytes(response);
}

function makeCommandItem(
  index: number,
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  return {
    id: TurnItemId.make(`item-${index}`),
    type: "command_execution",
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index + 1,
    status: "completed",
    title: `Command ${index}`,
    input: `cmd-${index}`,
    output: "x".repeat(OUTPUT_BYTES_PER_ROW),
    exitCode: 0,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  };
}

function makeTurnItemEvent(item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${item.id}`),
    type: "turn-item.updated",
    threadId: item.threadId,
    occurredAt: NOW,
    payload: item,
  };
}

describe("thread transport payload budget", () => {
  it("keeps a nine-megabyte command result out of thread and shell updates", () => {
    const output = "Build complete\n" + "x".repeat(9 * 1024 * 1024);
    const item = { ...makeCommandItem(0), output };
    const event = makeTurnItemEvent(item);
    const sequence = 2;
    const projected = projectDomainEventForWire(event);
    expect(projected.payload).toMatchObject({
      type: "command_execution",
      input: item.input,
      status: "completed",
      exitCode: 0,
      outputOmitted: true,
    });
    expect(projected.payload).not.toHaveProperty("output");
    expect(
      encodedThreadStreamChunkBytes({ kind: "event", sequence, event: projected }),
    ).toBeLessThanOrEqual(MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES);

    const otherThreadId = ThreadId.make("other-live-thread");
    const stored = {
      sequence,
      commandId: null,
      event: makeTurnItemEvent({ ...item, threadId: otherThreadId }),
    };
    expect(shouldPublishShellApplicationEvent(stored, new Set())).toBe(true);
    expect(shouldPublishShellApplicationEvent(stored, new Set([otherThreadId]))).toBe(false);
    expect(toShellApplicationEvent(stored)).toEqual({
      sequence,
      event: { threadId: otherThreadId },
    });

    const detail = projectTurnItemForDetail(item);
    const detailOutput = detail.type === "command_execution" ? (detail.output ?? "") : "";
    expect(detailOutput).toMatch(/^Build complete\n/);
    expect(Buffer.byteLength(detailOutput, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(item.output).toBe(output);
  });

  it("omits command output from a live event without changing persisted source data", () => {
    const sourceItem = makeCommandItem(0);
    const sourceEvent = makeTurnItemEvent(sourceItem);
    const projectedEvent = projectDomainEventForWire(sourceEvent);
    const preOmissionStreamItem: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 1,
      event: sourceEvent,
    };
    const projectedStreamItem: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 1,
      event: projectedEvent,
    };

    const preOmissionRpcJsonBytes = encodedThreadStreamChunkBytes(preOmissionStreamItem);
    const projectedRpcJsonBytes = encodedThreadStreamChunkBytes(projectedStreamItem);

    expect(preOmissionRpcJsonBytes).toBe(PRE_OMISSION_COMMAND_EVENT_RPC_JSON_BYTES);
    expect(projectedRpcJsonBytes).toBeLessThanOrEqual(MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES);
    expect(projectedRpcJsonBytes / preOmissionRpcJsonBytes).toBeLessThanOrEqual(0.1);
    expect(sourceItem).toHaveProperty("output", "x".repeat(OUTPUT_BYTES_PER_ROW));
    expect(projectedEvent.payload).not.toHaveProperty("output");
  });
});
