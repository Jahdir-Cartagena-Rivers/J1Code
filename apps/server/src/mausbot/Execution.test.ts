// @effect-diagnostics nodeBuiltinImport:off - isolated native attachment fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@j1code/contracts";
import { layerTest } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../provider/Services/ProviderRegistry.ts";
import { MausbotExecution, botExecutionThreadId } from "./Execution.ts";
import { botExecutionContext } from "./ExecutionContext.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

const input = {
  action: "start",
  botId: "bot",
  threadId: "thread",
  turnId: "native-turn",
  botName: "Handwriting",
  title: "Existing assignment",
  instanceId: "codex-account",
  model: "model",
  effort: "high",
  cwd: "C:/bot-workspace",
  projectId: "career",
  text: "Keep the accepted layout.",
  system: "Saved bot instructions",
  recoveryText: "Previous user and assistant messages",
  approvalMode: "ask",
  guestConfined: false,
  images: [],
  sharedContinuation: false,
  restrictedTools: false,
  tools: [{ name: "team_post", inputSchema: { type: "object" } }],
} as const;
const threadId = botExecutionThreadId(input.botId, input.threadId);

function fixture(
  test: (value: {
    service: MausbotExecution["Service"];
    commands: OrchestrationCommand[];
    stopped: ThreadId[];
    root: string;
    publish(event: ProviderRuntimeEvent): Promise<void>;
    publishCatalog(): Promise<void>;
  }) => Promise<void>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-bot-execution-"))),
    (root) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
        const catalogQueue = yield* Queue.unbounded<void>();
        const commands: OrchestrationCommand[] = [];
        const stopped: ThreadId[] = [];
        const projects = new Map<string, OrchestrationProjectShell>([
          [
            "career",
            {
              id: ProjectId.make("career"),
              title: "Career Moves",
              workspaceRoot: root,
            } as OrchestrationProjectShell,
          ],
        ]);
        const threads = new Map<string, OrchestrationThreadShell>();
        const history = new Map<string, ReadonlyArray<unknown>>();
        const engine = {
          dispatch: (command: OrchestrationCommand) =>
            Effect.sync(() => {
              commands.push(command);
              if (command.type === "project.create")
                projects.set(command.projectId, {
                  id: command.projectId,
                  title: command.title,
                  workspaceRoot: command.workspaceRoot,
                } as OrchestrationProjectShell);
              if (command.type === "thread.create")
                threads.set(command.threadId, {
                  id: command.threadId,
                  projectId: command.projectId,
                } as OrchestrationThreadShell);
              if (command.type === "thread.history.import")
                history.set(command.threadId, command.messages);
              return { sequence: commands.length };
            }),
          subscribeDomainEvents: Effect.succeed(Stream.never),
        } as unknown as OrchestrationEngineShape;
        const query = {
          getThreadShellById: (id: ThreadId) =>
            Effect.succeed(Option.fromNullishOr(threads.get(id))),
          getProjectShellById: (id: ProjectId) =>
            Effect.succeed(Option.fromNullishOr(projects.get(id))),
          getProjectShells: () => Effect.succeed([...projects.values()]),
          getThreadDetailById: (id: ThreadId) =>
            Effect.succeed(Option.some({ id, messages: history.get(id) ?? [] })),
        } as unknown as ProjectionSnapshotQueryShape;
        const providers = {
          streamEvents: Stream.fromQueue(queue),
          stopSession: ({ threadId }: { threadId: ThreadId }) =>
            Effect.sync(() => {
              stopped.push(threadId);
            }),
          interruptTurn: () => Effect.void,
        } as unknown as ProviderServiceShape;
        const registry = {
          streamChanges: Stream.fromQueue(catalogQueue).pipe(Stream.map(() => [])),
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("codex-account"),
              driver: "codex",
              enabled: true,
            },
          ]),
        } as unknown as ProviderRegistryShape;
        return yield* Effect.gen(function* () {
          const service = yield* MausbotExecution;
          yield* Effect.promise(() =>
            test({
              service,
              commands,
              stopped,
              root,
              publishCatalog: () => {
                Queue.offerUnsafe(catalogQueue, undefined);
                return Promise.resolve();
              },
              publish: (event) => {
                Queue.offerUnsafe(queue, event);
                return Promise.resolve();
              },
            }),
          );
        }).pipe(
          Effect.provide(MausbotExecution.layer),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ProjectionSnapshotQuery, query),
          Effect.provideService(ProviderService, providers),
          Effect.provideService(ProviderRegistry, registry),
          Effect.provideService(ServerSettingsService, {
            getSettings: Effect.succeed({ providerInstances: {}, providers: {} }),
          } as unknown as ServerSettingsService["Service"]),
        );
      }).pipe(
        Effect.provide(Layer.provideMerge(layerTest(process.cwd(), root), NodeServices.layer)),
        Effect.scoped,
      ),
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );
}

describe("native bot shared execution", () => {
  it.effect(
    "updates shared account catalogs and retires the old captured runtime's subscription",
    () =>
      fixture(async ({ service, publishCatalog }) => {
        let oldCount = 0;
        let newCount = 0;
        let notified!: () => void;
        const notification = new Promise<void>((resolve) => {
          notified = resolve;
        });
        await service.call(
          { action: "watch-catalog" },
          () => true,
          () => {
            oldCount++;
          },
          "old",
        );
        await service.call(
          { action: "watch-catalog" },
          () => true,
          () => {
            if (++newCount === 2) notified();
          },
          "new",
        );
        await service.disconnect("old");
        await publishCatalog();
        await notification;
        expect(oldCount).toBe(1);
        expect(newCount).toBe(2);
      }),
  );
  it.effect(
    "executes the bot's own registered conversation in the selected project with the same account, model and permission mode",
    () =>
      fixture(async ({ service, commands, root }) => {
        expect(
          await service.call(
            input,
            () => true,
            () => {},
            "child",
          ),
        ).toEqual({ turnId: "native-turn" });
        const create = commands.find((command) => command.type === "thread.create");
        expect(create).toMatchObject({
          type: "thread.create",
          threadId,
          projectId: "career",
          bot: { name: "Handwriting" },
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId: "codex-account",
            model: "model",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        });
        expect(commands.at(-1)).toMatchObject({
          type: "thread.turn.start",
          threadId,
          message: { text: input.text },
          runtimeMode: "approval-required",
        });
        expect(botExecutionContext(threadId)?.prompt).toContain(root);
        expect(botExecutionContext(threadId)?.prompt).toContain(input.recoveryText);
        expect(botExecutionContext(ThreadId.make("neighbor"))).toBeUndefined();
        expect(commands.some((command) => command.type === "project.create")).toBe(false);
      }).pipe(
        Effect.tap(() => Effect.sync(() => expect(botExecutionContext(threadId)).toBeUndefined())),
      ),
  );

  it.effect(
    "rejects guest escalation, unknown accounts and unknown protocol fields before creating a conversation",
    () =>
      fixture(async ({ service, commands }) => {
        await expect(
          service.call(
            { ...input, guestConfined: true },
            () => true,
            () => {},
            "child",
          ),
        ).rejects.toThrow("guest");
        await expect(
          service.call(
            { ...input, instanceId: "other-account" },
            () => true,
            () => {},
            "child",
          ),
        ).rejects.toThrow("unavailable");
        await expect(
          service.call(
            { ...input, future: true },
            () => true,
            () => {},
            "child",
          ),
        ).rejects.toThrow();
        expect(commands).toEqual([]);
      }),
  );

  it.effect("keeps tool replies on their original bot, thread and captured child connection", () =>
    fixture(async ({ service }) => {
      let toolRequest: Record<string, unknown> | undefined;
      await service.call(
        input,
        () => true,
        (event) => {
          toolRequest = event as Record<string, unknown>;
        },
        "child",
      );
      const result = botExecutionContext(threadId)!.call(
        "team_post",
        { text: "Ready" },
        new AbortController().signal,
      );
      expect(toolRequest).toMatchObject({
        kind: "tool-call",
        botId: "bot",
        threadId: "thread",
        name: "team_post",
      });
      const reply = {
        action: "tool-result",
        botId: "bot",
        threadId: "thread",
        requestId: toolRequest!.requestId,
        value: { ok: true, text: "Posted" },
      };
      await expect(
        service.call(
          reply,
          () => true,
          () => {},
          "other-child",
        ),
      ).rejects.toThrow("another runtime");
      await expect(
        service.call(
          { ...reply, botId: "neighbor" },
          () => true,
          () => {},
          "child",
        ),
      ).rejects.toThrow("no longer active");
      await service.call(
        reply,
        () => true,
        () => {},
        "child",
      );
      expect(await result).toEqual({ ok: true, text: "Posted" });
      await expect(
        service.call(
          reply,
          () => true,
          () => {},
          "child",
        ),
      ).rejects.toThrow("no longer active");
    }),
  );

  it.effect("does not let an old child's exit stop a replacement runtime's bot turn", () =>
    fixture(async ({ service, stopped }) => {
      await service.call(
        input,
        () => true,
        () => {},
        "new-child",
      );
      await service.disconnect("old-child");
      expect(stopped).toEqual([]);
      expect(botExecutionContext(threadId)).toBeDefined();
      await service.disconnect("new-child");
      expect(stopped).toEqual([threadId]);
      expect(botExecutionContext(threadId)).toBeUndefined();
    }),
  );

  it.effect(
    "serializes duplicate start requests and preserves the registered thread when its project is changed",
    () =>
      fixture(async ({ service, commands }) => {
        const results = await Promise.allSettled([
          service.call(
            input,
            () => true,
            () => {},
            "child",
          ),
          service.call(
            input,
            () => true,
            () => {},
            "child",
          ),
        ]);
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
        expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
        await service.disconnect("child");
        await expect(
          service.call(
            { ...input, projectId: undefined, cwd: "different" },
            () => true,
            () => {},
            "child",
          ),
        ).resolves.toEqual({ turnId: "native-turn" });
        expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
        expect(botExecutionContext(threadId)?.prompt).not.toContain(input.recoveryText);
      }),
  );

  it.effect(
    "materializes the original bot image for the shared provider and rejects a changed attachment",
    () =>
      fixture(async ({ service, commands, root }) => {
        const file = NodePath.join(root, "source.png");
        await NodeFSP.writeFile(file, "image-fixture");
        await expect(
          service.call(
            { ...input, images: [{ path: file, mime: "image/png", bytes: 1 }] },
            () => true,
            () => {},
            "child",
          ),
        ).rejects.toThrow("changed");
        await service.call(
          { ...input, images: [{ path: file, mime: "image/png", bytes: 13 }] },
          () => true,
          () => {},
          "child",
        );
        const turn = commands.find((command) => command.type === "thread.turn.start");
        if (turn?.type !== "thread.turn.start") throw new Error("Missing shared turn");
        expect(turn.message.attachments).toHaveLength(1);
        const path = resolveAttachmentPath({
          attachmentsDir: NodePath.join(root, "userdata", "attachments"),
          attachment: turn.message.attachments[0]!,
        });
        expect(await NodeFSP.readFile(path!, "utf8")).toBe("image-fixture");
      }),
  );

  it.effect("imports the original transcript once and preserves it on later resumes", () =>
    fixture(async ({ service, commands }) => {
      const transcript = [
        { role: "user", text: "Original instruction" },
        { role: "assistant", text: "Accepted result" },
      ];
      await service.call(
        { ...input, transcript },
        () => true,
        () => {},
        "child",
      );
      expect(commands.find((command) => command.type === "thread.history.import")).toMatchObject({
        messages: transcript,
      });
      await service.disconnect("child");
      await service.call(
        {
          ...input,
          transcript: [...transcript, { role: "user", text: "Continue" }],
          sharedContinuation: true,
        },
        () => true,
        () => {},
        "child",
      );
      expect(commands.filter((command) => command.type === "thread.history.import")).toHaveLength(
        1,
      );
    }),
  );

  it.effect("retires active tools on a real terminal event without clearing the saved thread", () =>
    fixture(async ({ service, publish, commands }) => {
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await service.call(
        input,
        () => true,
        (event) => {
          if ((event as { event?: { type?: string } }).event?.type === "turn.completed") finish();
        },
        "child",
      );
      await publish({
        eventId: "done",
        provider: "codex",
        threadId,
        createdAt: "2026-11-18T00:00:00Z",
        type: "turn.completed",
        payload: { state: "completed" },
      } as unknown as ProviderRuntimeEvent);
      await completed;
      expect(botExecutionContext(threadId)).toBeUndefined();
      expect(commands.some((command) => command.type === "thread.delete")).toBe(false);
    }),
  );
});
