import { expect, it } from "@effect/vitest";
import {
  AgentSessionScanError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionImportInput,
} from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { layerTest, ServerSettingsService } from "../serverSettings.ts";
import { makeLiveHistoryRefresh } from "./AgentHistoryLive.ts";
import { AgentSessionImporter } from "./AgentSessionImporter.ts";
import { ProjectService } from "./ProjectService.ts";

const account = ProviderInstanceId.make("codex");
const project = ProjectId.make("project");
const other = ProjectId.make("other");
const threadId = (sessionId: string) => ThreadId.make(`import:codex:${sessionId}`);

function setup() {
  const sessions = ["owned", "active", "authored", "bot", "foreign", "missing", "neighbor"];
  const calls: Array<{
    input: AgentSessionImportInput;
    sourcesOnly: boolean | undefined;
    eligible: ReadonlySet<ThreadId> | undefined;
  }> = [];
  let reads = 0;
  let failProject = true;
  const layer = Layer.mergeAll(
    layerTest({ liveAgentHistory: false }),
    Layer.mock(ProviderSessionRuntimeRepository)({
      list: () =>
        Effect.sync(() => {
          reads += 1;
          return sessions.map((sessionId) => ({
            threadId: threadId(sessionId),
            providerName: "codex",
            providerInstanceId: account,
            adapterKey: "codex",
            runtimeMode: "full-access" as const,
            status: "stopped" as const,
            lastSeenAt: "2026-11-19T00:00:00.000Z",
            resumeCursor: { threadId: sessionId },
            runtimePayload: {
              importedTranscripts: [{
                provider: "codex",
                providerInstanceId: account,
                providerSessionId: sessionId,
                filePath: `/source/${sessionId}.jsonl`,
                size: 100,
                mtimeMs: 1,
                device: 1,
                inode: "1",
                birthtimeMs: 1,
              }],
            },
          }));
        }),
    }),
    Layer.mock(ProjectionStoreV2)({
      getThreadRecords: (id) => {
        const sessionId = id.slice(id.lastIndexOf(":") + 1);
        if (sessionId === "missing") {
          return Effect.fail({ _tag: "ProjectionStoreThreadNotFoundError", threadId: id } as never);
        }
        return Effect.succeed({
          thread: {
            id,
            projectId: sessionId === "neighbor" ? other : project,
            historyOrigin: "v1_import",
            archivedAt: null,
            deletedAt: null,
            bot: sessionId === "bot" ? {} : undefined,
            providerInstanceId: account,
            activeProviderThreadId: "provider-row",
          },
          messages: [{
            id: `${id}:000000`,
            creationSource: sessionId === "authored" ? "web" : "server",
            runId: null,
            role: "user",
          }],
          runs: [],
          runtimeRequests: [],
          plans: [],
          providerThreads: [{
            id: "provider-row",
            appThreadId: id,
            driver: "codex",
            providerInstanceId: account,
            providerSessionId: null,
            nativeThreadRef: {
              driver: "codex",
              nativeId: sessionId === "foreign" ? "wrong-native" : sessionId,
              strength: "strong",
            },
            status: sessionId === "active" ? "running" : "idle",
          }],
        } as never);
      },
    }),
    Layer.mock(ProjectService)({
      getById: (id) =>
        Effect.succeedSome({
          id,
          archivedAt: null,
          deletedAt: null,
          workspaceRoot: `/work/${id}`,
        } as never),
    }),
    Layer.mock(AgentSessionImporter)({
      importRecentAgentThreads: (input, sourcesOnly, eligible) => {
        calls.push({ input, sourcesOnly, eligible });
        return input.projectId === project && failProject
          ? Effect.fail(new AgentSessionScanError({ operation: "read-projects", cause: "test" }))
          : Effect.succeed({ importedCount: 0, skippedCount: 0 });
      },
    }),
  );
  return { layer, calls, reads: () => reads, recovered: () => { failProject = false; } };
}

it.effect("refreshes only owned idle source threads and backs off a failed project", () => {
  const harness = setup();
  return Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const { refresh } = yield* makeLiveHistoryRefresh;
    yield* refresh;
    expect(harness.reads()).toBe(0);
    yield* settings.updateSettings({ liveAgentHistory: true });
    yield* refresh;
    expect(harness.calls).toEqual([
      {
        input: { projectId: project, expectedWorkspaceRoot: "/work/project" },
        sourcesOnly: true,
        eligible: new Set([threadId("owned")]),
      },
      {
        input: { projectId: other, expectedWorkspaceRoot: "/work/other" },
        sourcesOnly: true,
        eligible: new Set([threadId("neighbor")]),
      },
    ]);

    yield* refresh;
    expect(harness.calls.map(({ input }) => input.projectId)).toEqual([project, other, other]);
    yield* settings.updateSettings({ liveAgentHistory: false });
    yield* TestClock.adjust("30 seconds");
    const reads = harness.reads();
    yield* refresh;
    expect(harness.reads()).toBe(reads);
    yield* settings.updateSettings({ liveAgentHistory: true });
    harness.recovered();
    yield* refresh;
    expect(harness.calls.slice(-2).map(({ input }) => input.projectId)).toEqual([project, other]);
  }).pipe(Effect.provide(harness.layer));
});
