import { expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { hiveEventId, type captureHiveEvent, type HivePacket } from "../hiveMind/backend.ts";
import { HiveRunPresence, prepareHiveTurnRecall } from "./HiveTurnRecall.ts";

const input = {
  file: "/fixture/hive-mind.json",
  query: "Match the saved test design",
  projects: ["Career Moves", "career-moves"],
  standalone: false,
  threadId: "test-thread",
  attachmentsDir: "/fixture/attachments",
  attachments: [],
  charactersAvailable: 1000,
};
const connection = { origin: "https://hive.invalid", token: "fixture-token" };
const packet: HivePacket = {
  context: "Saved test design",
  streamId: "fixture-stream",
  sequence: 7,
  usedIds: ["fact-one"],
  taskId: "task-one",
  project: "Career Moves",
  assets: [{ id: "picture", mime: "image/png", caption: "Fixture image" }],
};
const reference = {
  attachment: {
    type: "image" as const,
    id: "fixture-image",
    name: "fixture.png",
    mimeType: "image/png",
    sizeBytes: 32,
  },
  path: "/fixture/attachments/fixture.png",
};
const fixture = () => ({
  selectedHiveContext: vi.fn(async () => ({ context: packet.context, packet, connection })),
  materializeHiveImage: vi.fn(async () => reference),
  acknowledgeHiveContext: vi.fn(async () => {}),
  captureHiveEvent: vi.fn<typeof captureHiveEvent>(async () => ({
    id: "event",
    revision: "revision",
    project: null,
    scope: "general" as const,
    data: {},
  })),
});

it.effect("prepares scoped context and acknowledges only after the caller confirms delivery", () =>
  Effect.gen(function* () {
    const backend = fixture();
    const recall = yield* prepareHiveTurnRecall(input, backend);
    expect(backend.selectedHiveContext).toHaveBeenCalledWith(
      input.file,
      input.query,
      input.projects,
      input.threadId,
    );
    expect(recall?.prefix).toContain(reference.path);
    expect(recall?.attachments).toEqual([reference.attachment]);
    expect(backend.acknowledgeHiveContext).not.toHaveBeenCalled();
    expect(backend.captureHiveEvent).not.toHaveBeenCalled();
    if (!recall) return yield* Effect.die("Expected prepared recall");
    yield* recall.acknowledge("codex", "selected-account", "accepted-turn");
    expect(backend.acknowledgeHiveContext).toHaveBeenCalledWith(
      input.file,
      connection,
      input.threadId,
      packet,
    );
    expect(backend.captureHiveEvent).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({
        eventId: hiveEventId(
          input.file,
          input.threadId,
          "selected-account",
          "accepted-turn",
          "input",
        ),
        project: "Career Moves",
        assetIds: ["picture"],
        deliveredIds: ["fact-one"],
        contextSequence: 7,
        contextStreamId: "fixture-stream",
      }),
    );
  }),
);

it.effect(
  "skips greetings, attachment-only sends and native commands before contacting Hive Mind",
  () =>
    Effect.gen(function* () {
      const backend = fixture();
      for (const query of ["Hey Lin!", "", "/compact", "/goal"]) {
        expect(
          yield* prepareHiveTurnRecall(
            { ...input, query, attachments: [reference.attachment] },
            backend,
          ),
        ).toBeUndefined();
      }
      expect(backend.selectedHiveContext).not.toHaveBeenCalled();
    }),
);

it.effect("injects local context without external acknowledgments or capture", () =>
  Effect.gen(function* () {
    const backend = {
      ...fixture(),
      selectedHiveContext: vi.fn(async () => ({
        context: "Local context",
        connection: null,
        packet: null,
      })),
    };
    const recall = yield* prepareHiveTurnRecall(input, backend);
    expect(recall?.prefix).toBe("Local context\n\n");
    if (!recall) return yield* Effect.die("Expected local recall");
    yield* recall.acknowledge("codex", "selected-account", "accepted-turn");
    expect(backend.acknowledgeHiveContext).not.toHaveBeenCalled();
    expect(backend.captureHiveEvent).not.toHaveBeenCalled();
  }),
);

it.effect(
  "isolates standalone bots and preserves the authored turn on errors or budget overflow",
  () =>
    Effect.gen(function* () {
      const backend = fixture();
      expect(yield* prepareHiveTurnRecall({ ...input, standalone: true }, backend)).toBeUndefined();
      expect(backend.selectedHiveContext).toHaveBeenLastCalledWith(
        input.file,
        input.query,
        [],
        input.threadId,
      );
      expect(
        yield* prepareHiveTurnRecall({ ...input, charactersAvailable: 5 }, backend),
      ).toBeUndefined();
      expect(backend.materializeHiveImage).not.toHaveBeenCalled();

      const preserved = { ...reference.attachment, sizeBytes: 75 * 1024 * 1024 };
      const capped = yield* prepareHiveTurnRecall({ ...input, attachments: [preserved] }, backend);
      expect(capped?.attachments).toEqual([preserved]);
      expect(backend.materializeHiveImage).not.toHaveBeenCalled();

      backend.materializeHiveImage.mockRejectedValueOnce(new Error("reference unavailable"));
      const withoutReference = yield* prepareHiveTurnRecall(input, backend);
      expect(withoutReference?.prefix).toContain(packet.context);
      expect(withoutReference?.attachments).toEqual([]);
      if (!withoutReference) return yield* Effect.die("Expected text recall");
      backend.acknowledgeHiveContext.mockRejectedValueOnce(new Error("acknowledgment unavailable"));
      yield* withoutReference.acknowledge("codex", "selected-account", "accepted-turn");
      expect(backend.captureHiveEvent).not.toHaveBeenCalled();

      backend.selectedHiveContext.mockRejectedValueOnce(new Error("Hive unavailable"));
      expect(yield* prepareHiveTurnRecall(input, backend)).toBeUndefined();
    }),
);

it.effect("buffers a terminal outcome behind acknowledgment and retries only the exact turn", () =>
  Effect.gen(function* () {
    const backend = fixture();
    const acknowledgmentStarted = yield* Deferred.make<void>();
    const acknowledge = Promise.withResolvers<void>();
    backend.acknowledgeHiveContext.mockImplementationOnce(() => {
      Deferred.doneUnsafe(acknowledgmentStarted, Effect.void);
      return acknowledge.promise;
    });
    const recall = yield* prepareHiveTurnRecall(input, backend);
    if (!recall) return yield* Effect.die("Expected recall");
    const tracked = yield* recall.track("codex", "selected-account", "accepted-turn");
    if (!tracked) return yield* Effect.die("Expected external turn tracking");
    tracked.append("child-turn", "child-item", "Neighbor output");
    tracked.append("accepted-turn", "root-item", "Partial root output");
    tracked.append("accepted-turn", "root-item", "Final root output");
    expect(tracked.finish("child-turn", "failed")).toBeUndefined();
    const outcome = tracked.finish("accepted-turn", "interrupted");
    expect(tracked.finish("accepted-turn", "completed")).toBeUndefined();
    if (!outcome) return yield* Effect.die("Expected one terminal capture");
    const ackFiber = yield* tracked.acknowledged.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(acknowledgmentStarted);
    const terminalFiber = yield* outcome.pipe(Effect.forkChild({ startImmediately: true }));
    expect(backend.captureHiveEvent).not.toHaveBeenCalled();
    const capture = backend.captureHiveEvent.getMockImplementation()!;
    backend.captureHiveEvent
      .mockImplementationOnce(capture)
      .mockRejectedValueOnce(new Error("transient outcome failure"));
    acknowledge.resolve();
    yield* Fiber.join(ackFiber);
    yield* Fiber.join(terminalFiber);
    expect(backend.acknowledgeHiveContext).toHaveBeenCalledTimes(1);
    const outcomes = backend.captureHiveEvent.mock.calls.slice(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toEqual([
      connection,
      expect.objectContaining({
        eventId: hiveEventId(
          input.file,
          input.threadId,
          "selected-account",
          "accepted-turn",
          "terminal",
        ),
        summary: expect.stringContaining("Provider reported interrupted"),
      }),
    ]);
    expect(outcomes[0]?.[1]?.summary).toContain("Final root output");
    expect(outcomes[0]?.[1]?.summary).not.toMatch(/Neighbor output|Partial root output/);
  }),
);

it.effect("keeps standalone outcomes general and stops retrying after three failures", () =>
  Effect.gen(function* () {
    const backend = fixture();
    backend.selectedHiveContext.mockResolvedValueOnce({
      context: packet.context,
      connection,
      packet: { ...packet, project: null, assets: [] },
    });
    const recall = yield* prepareHiveTurnRecall({ ...input, standalone: true }, backend);
    if (!recall) return yield* Effect.die("Expected general recall");
    const tracked = yield* recall.track("codex", "selected-account", "accepted-standalone");
    if (!tracked) return yield* Effect.die("Expected accepted standalone turn");
    yield* tracked.acknowledged;
    backend.captureHiveEvent.mockRejectedValue(new Error("fixture backend unavailable"));
    const outcome = tracked.finish("accepted-standalone", "failed");
    if (!outcome) return yield* Effect.die("Expected terminal capture");
    yield* outcome;
    expect(backend.captureHiveEvent).toHaveBeenCalledTimes(4);
    expect(backend.captureHiveEvent.mock.calls.every(([, event]) => event.project === null)).toBe(
      true,
    );
  }),
);

it("keeps presence on its exact owner through replacement, heartbeat failure and cleanup", async () => {
  let now = 0;
  let waitingReports = 0;
  const reports: Record<string, unknown>[] = [];
  const presence = new HiveRunPresence(
    async (_connection, body) => {
      reports.push(body);
      if (body.chatId === "tracked" && body.status === "waiting" && ++waitingReports === 2) {
        throw new Error("fixture heartbeat failure");
      }
    },
    () => now,
  );
  const target = { connection, provider: "codex" };
  const old = presence.begin("tracked", target)!;
  const neighbor = presence.begin("neighbor", target)!;
  const replacement = presence.begin("tracked", target)!;
  old.observe({ type: "request.opened" });
  old.end();
  replacement.observe({ type: "request.opened", payload: { prompt: "private text" } });
  now = 30_000;
  presence.heartbeat();
  now = 60_000;
  presence.heartbeat();
  replacement.finish();
  neighbor.end();
  const shutdown = presence.begin("shutdown", target)!;
  await presence.close();
  shutdown.end();
  expect(presence.begin("late", target)).toBeUndefined();
  const tracked = reports.filter(({ chatId }) => chatId === "tracked");
  expect(tracked.map(({ status }) => status)).toEqual([
    "working",
    "working",
    "waiting",
    "waiting",
    "waiting",
    "idle",
  ]);
  expect(JSON.stringify(reports)).not.toContain("private text");
  expect(
    reports
      .filter(({ action }) => action === "end")
      .map(({ chatId }) => chatId)
      .sort(),
  ).toEqual(["neighbor", "shutdown"]);
});
