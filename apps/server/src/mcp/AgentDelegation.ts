import {
  AGENT_DELEGATION_MAX_ACTIVE, AGENT_DELEGATION_MAX_DEPTH, AGENT_DELEGATION_MAX_TOTAL,
  AgentDelegationError, CommandId, isRuntimeModeAbove,
  type AgentDelegationResult, type OrchestrationV2StoredEvent, type OrchestrationV2Subagent,
  type OrchestrationV2Run, type OrchestrationV2ThreadShell, type ProviderOptionDescriptor,
  type RunId, type ServerProvider, type SpawnAgentInput, type ThreadId,
} from "@j1code/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ThreadManagementService, isActiveRun } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { nativeAgentCaller } from "./toolkits/routing/boundary.ts";

const OUTPUT_LIMIT = 24_000;
const MAX_ACTIVE_WORKERS = 16;
const failure = (message: string) => new AgentDelegationError({ message });
const unavailable = () => failure("This worker does not belong to your lead chat or is unavailable.");
const wrap = (message: string) => Effect.mapError(() => failure(message));

/** V2 reports the durable queue state and effective deadline when present. */
export type AgentDelegationV2Result =
  Omit<AgentDelegationResult, "status" | "deadlineAt"> & {
    readonly status: AgentDelegationResult["status"] | "queued";
    readonly deadlineAt?: AgentDelegationResult["deadlineAt"];
  };

const limits = {
  maxDepth: AGENT_DELEGATION_MAX_DEPTH,
  maxActivePerLead: AGENT_DELEGATION_MAX_ACTIVE,
  maxWorkersPerTurn: AGENT_DELEGATION_MAX_TOTAL,
};

type Worker = {
  readonly task: OrchestrationV2Subagent;
  readonly child: OrchestrationV2ThreadShell;
  readonly depth: number;
  readonly rootRunId: RunId | null;
};
const liveStatus = (status: AgentDelegationV2Result["status"]) =>
  status === "queued" || status === "starting" || status === "running" || status === "waiting";

function workerStatus(task: OrchestrationV2Subagent, run: OrchestrationV2Run | undefined, pendingInput: boolean):
  AgentDelegationV2Result["status"] {
  switch (task.status) {
    case "completed":
    case "failed":
      return task.status;
    case "cancelled":
    case "interrupted":
      return task.deadlineCancellationAt === undefined ? task.status : "timed-out";
  }
  if (pendingInput || run?.status === "waiting") return "waiting";
  if (run?.status === "queued") return "queued";
  if (run === undefined || run.status === "preparing" || run.status === "starting") return "starting";
  // A terminal run alone is not the result. V2 may still owe a continuation or descendant return.
  return "running";
}

function providerAvailable(provider: ServerProvider): boolean {
  return provider.enabled && provider.installed &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.availability !== "unavailable" && provider.auth.status !== "unauthenticated";
}

function optionsValid(pick: SpawnAgentInput["modelSelection"], descriptors?: ReadonlyArray<ProviderOptionDescriptor>) {
  const supplied = pick.options ?? [];
  return new Set(supplied.map(({ id }) => id)).size === supplied.length &&
    (descriptors === undefined || supplied.every(({ id, value }) => {
      const descriptor = descriptors.find((entry) => entry.id === id);
      return descriptor?.type === "boolean" ? typeof value === "boolean" :
        descriptor?.type === "select" && descriptor.options.some((option) => option.id === value);
    }));
}

const encodeCommandIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])));
const stableId = (kind: "spawn" | "cancel", parent: ThreadId, request: string) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(encodeCommandIdentity([parent, request]))),
    catch: () => failure("Could not derive the saved delegation command identity."),
  }).pipe(Effect.map((digest) => CommandId.make(`j1-agent:${kind}:${Buffer.from(digest).toString("hex")}`)));

function sameSelection(left: SpawnAgentInput["modelSelection"], right: SpawnAgentInput["modelSelection"]): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  if (left.options === undefined || right.options === undefined) return left.options === right.options;
  return left.options.length === right.options.length && left.options.every(({ id, value }, index) =>
    right.options?.[index]?.id === id && right.options[index]?.value === value);
}

function findSpawn(
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
  parent: ThreadId,
  input: SpawnAgentInput,
): OrchestrationV2Subagent | undefined {
  for (const { event } of events) {
    if (event.type !== "subagent.updated" || event.threadId !== parent) continue;
    const task = event.payload;
    if (task.origin === "app_owned" && task.threadId === parent &&
        task.childThreadId !== null && task.prompt === input.task && task.title === input.title &&
        task.deadlineTimeoutSeconds === input.timeoutSeconds &&
        task.modelSelection !== undefined && sameSelection(task.modelSelection, input.modelSelection))
      return task;
  }
  return undefined;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const environment = yield* ServerEnvironment;
  const registry = yield* ProviderInstanceRegistry;
  const events = yield* EventSinkV2;
  const settings = yield* ServerSettingsService;
  // Only bridge admission is serialized. V2 owns persistence, execution and recovery.
  const admission = yield* Semaphore.make(1);
  const authorize = (invocation: McpInvocationScope) =>
    nativeAgentCaller.pipe(
      Effect.provideService(McpInvocationContext, invocation),
      Effect.provideService(ThreadManagementService, threads),
      Effect.provideService(ServerEnvironment, environment),
      Effect.mapError(failure),
    );

  const loadShell = (id: ThreadId) => threads.getThreadShell(id).pipe(wrap("Could not read the saved worker."));
  const listChildren = (shell: OrchestrationV2ThreadShell) => threads.getThreadRecords(shell.id, ["subagents"]).pipe(
    Effect.map(({ subagents }) => subagents.filter((task) =>
      task.threadId === shell.id && task.origin === "app_owned" && task.childThreadId !== null)),
    wrap("Could not read saved delegated work."),
  );

  const family = Effect.fn("AgentDelegation.family")(function* (root: OrchestrationV2ThreadShell, strict = false) {
    const visited = new Set<ThreadId>([root.id]);
    const workers: Worker[] = [];
    const queue = [{ shell: root, depth: 0, rootRunId: null as RunId | null }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { shell, depth, rootRunId } = queue[cursor]!;
      for (const task of yield* listChildren(shell)) {
        const childId = task.childThreadId!;
        if (visited.has(childId)) {
          if (strict) return yield* unavailable();
          continue;
        }
        const child = yield* loadShell(childId);
        if (!child || child.id !== childId || child.deletedAt !== null ||
            child.projectId !== root.projectId || child.lineage.relationshipToParent !== "subagent" ||
            child.lineage.parentThreadId !== shell.id || child.lineage.rootThreadId !== root.lineage.rootThreadId ||
            child.forkedFrom?.type !== "node" || child.forkedFrom.nodeId !== task.id) {
          if (strict && child?.deletedAt !== null) return yield* unavailable();
          continue;
        }
        visited.add(childId);
        const parentRun = depth === 0 ? task.runId : rootRunId;
        workers.push({ task, child, depth: depth + 1, rootRunId: parentRun });
        queue.push({ shell: child, depth: depth + 1, rootRunId: parentRun });
      }
    }
    return workers;
  });

  const owned = Effect.fn("AgentDelegation.owned")(function* (parent: OrchestrationV2ThreadShell, id: ThreadId) {
    const worker = (yield* family(parent)).find(({ child }) => child.id === id);
    if (!worker) return yield* unavailable();
    return worker;
  });

  const readWorker = Effect.fn("AgentDelegation.result")(function* ({ task, child }: Worker) {
    const { runs, runtimeRequests, nodes, contextTransfers } = yield* threads.getThreadRecords(
      child.id, ["runs", "runtimeRequests", "nodes", "contextTransfers"],
    ).pipe(wrap("Could not read saved worker progress."));
    // The original V2 spawn is correlated by its durable context transfer. Only
    // later explicitly delegated continuations necessarily carry delegatedTaskId.
    const start = contextTransfers.find((transfer) =>
      transfer.type === "subagent_spawn" && transfer.targetThreadId === child.id &&
      transfer.sourceThreadId === task.threadId && transfer.sourcePoint.runId === task.runId,
    )?.targetRunId;
    const runIds = new Set<RunId>();
    const taskRuns = runs.toSorted((a, b) => a.ordinal - b.ordinal).filter((run) => {
      const prior = run.restartContinuationOfRunId ?? run.usageLimitContinuationOfRunId;
      if (run.threadId !== child.id || (run.id !== start && run.delegatedTaskId !== task.id &&
          (prior === undefined || !runIds.has(prior)))) return false;
      runIds.add(run.id);
      return true;
    });
    const current = taskRuns.at(-1);
    const nodeIds = new Set(nodes.filter((node) => node.runId !== null && runIds.has(node.runId)).map(({ id }) => id));
    const pendingInput = runtimeRequests.some((request) =>
      request.status === "pending" && nodeIds.has(request.nodeId) &&
      request.kind !== "dynamic_tool_call" && request.kind !== "auth_refresh" &&
      request.responseCapability.type === "live");
    const status = workerStatus(task, current, pendingInput);
    // Completion summaries come from the durable task. Until then expose only assistant
    // messages whose run belongs to this exact delegation, never later manual work.
    const savedMessages = task.result === null && runIds.size > 0
      ? (yield* threads.getThreadRecords(child.id, ["messages"], {
          messageRunIds: [...runIds], messageRoles: ["assistant"],
        }).pipe(wrap("Could not read the saved worker response."))).messages
      : [];
    const output = task.result ?? savedMessages.filter((message) =>
      message.role === "assistant" && message.runId !== null && runIds.has(message.runId))
      .map(({ text }) => text).join("\n\n");
    const error = status === "timed-out"
      ? "The delegated worker reached its deadline."
      : status === "failed" || status === "interrupted"
        ? output || ("Worker " + status + ". See the saved Worker chat.")
        : null;
    return {
      threadId: child.id,
      parentThreadId: task.threadId,
      title: task.title ?? child.title,
      modelSelection: task.modelSelection ?? child.modelSelection,
      status,
      output: output.slice(-OUTPUT_LIMIT),
      outputTruncated: output.length > OUTPUT_LIMIT,
      error: error?.slice(-OUTPUT_LIMIT) ?? null,
      ...(task.deadlineAt === undefined ? {} : { deadlineAt: DateTime.formatIso(task.deadlineAt) }),
    } satisfies AgentDelegationV2Result;
  });

  const readOwned = Effect.fn("AgentDelegation.readOwned")(function* (id: ThreadId, invocation: McpInvocationScope) {
    const { caller } = yield* authorize(invocation);
    return yield* readWorker(yield* owned(caller, id));
  });
  const currentLimit = (parent: OrchestrationV2ThreadShell) => {
    const managed = settings.managedPolicy?.limits?.maxRuntimeMode;
    return {
      runtimeMode: managed !== undefined && isRuntimeModeAbove(parent.runtimeMode, managed) ? managed : parent.runtimeMode,
      interactionMode: parent.interactionMode,
    };
  };

  return {
    models: Effect.fn("AgentDelegation.models")(function* (invocation: McpInvocationScope) {
      const { caller } = yield* authorize(invocation);
      const instances = yield* registry.listInstances;
      const known = yield* Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot);
      const unavailableProviders = yield* registry.listUnavailable;
      const providers = yield* Effect.forEach([...known, ...unavailableProviders], (provider) =>
        threads.isProviderInstanceEnabledForProject({
          projectId: caller.projectId, instanceId: provider.instanceId,
        }).pipe(Effect.map((projectEnabled) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          name: provider.displayName ?? provider.driver,
          enabled: provider.enabled && projectEnabled,
          available: projectEnabled && providerAvailable(provider),
          authStatus: provider.auth.status,
          models: provider.models.map(({ slug, name }) => ({ model: slug, name })),
        }))),
      );
      return { providers, limits };
    }),
    spawn: (input: SpawnAgentInput, invocation: McpInvocationScope) => admission.withPermits(1)(
      Effect.gen(function* () {
        const { caller: originalParent } = yield* authorize(invocation);
        if (!optionsValid(input.modelSelection))
          return yield* failure("A model option was specified more than once.");
        const commandId = yield* stableId("spawn", originalParent.id, input.requestId);
        const { caller: parent } = yield* authorize(invocation);
        if (parent.id !== originalParent.id) return yield* unavailable();
        const replay = yield* events.readByCommandId({ commandId }).pipe(
          Stream.runCollect, wrap("Could not check the delegation receipt."),
        );
        if (replay.length > 0) {
          const saved = findSpawn(replay, parent.id, input);
          if (!saved?.childThreadId) return yield* failure("This requestId was already used for a different task.");
          return yield* readWorker(yield* owned(parent, saved.childThreadId));
        }
        // A receipt without the original event evidence does not authorize a second child.
        if (yield* threads.hasReceipt(commandId))
          return yield* failure("The saved delegation receipt has no verifiable child evidence.");

        let root = parent;
        const visited = new Set<ThreadId>([parent.id]);
        while (root.lineage.relationshipToParent === "subagent") {
          const ownerId = root.lineage.parentThreadId;
          if (ownerId === null || visited.has(ownerId)) return yield* unavailable();
          visited.add(ownerId);
          const next = yield* loadShell(ownerId);
          if (!next || next.projectId !== parent.projectId || next.deletedAt !== null || next.archivedAt !== null)
            return yield* unavailable();
          root = next;
        }
        const workers = yield* family(root);
        const nested = root.id === parent.id ? undefined : workers.find(({ child }) => child.id === parent.id);
        if (root.id !== parent.id && !nested) return yield* unavailable();
        if ((nested?.depth ?? 0) + 1 > limits.maxDepth)
          return yield* failure("Worker delegation depth limit reached.");
        const { runs } = yield* threads.getThreadRecords(parent.id, ["runs"]).pipe(
          wrap("Could not verify the active parent run."),
        );
        const parentRun = runs.find((run) => run.id === parent.activeRunId &&
          run.threadId === parent.id && run.providerInstanceId === invocation.thread?.providerInstanceId &&
          isActiveRun(run));
        if (!parentRun?.rootNodeId) return yield* failure("The calling provider no longer owns an active run.");
        const rootRunId = nested ? nested.rootRunId : parentRun.id;
        if (rootRunId === null) return yield* failure("Could not recover the root worker budget.");
        if (workers.filter((worker) => worker.rootRunId === rootRunId).length >= limits.maxWorkersPerTurn)
          return yield* failure("Worker budget for this lead turn is exhausted.");
        if (workers.filter(({ task }) => liveStatus(workerStatus(task, undefined, false))).length >= limits.maxActivePerLead)
          return yield* failure("Active worker limit reached. Wait for or cancel an existing worker.");
        const allThreads = yield* threads.listProjectThreads({ includeSubagents: true }).pipe(
          wrap("Could not verify the active worker limit."),
        );
        const maybeActive = allThreads.filter(({ lineage }) => lineage.relationshipToParent === "subagent");
        if (maybeActive.length >= MAX_ACTIVE_WORKERS) {
          const shells = yield* Effect.forEach(maybeActive, ({ id }) => loadShell(id));
          if (shells.filter((row) => row && row.archivedAt === null && row.deletedAt === null &&
              (row.activeRunId !== null || row.status === "queued" || row.status === "running")).length >= MAX_ACTIVE_WORKERS)
            return yield* failure("Active worker limit reached in this environment.");
        }

        const pick = input.modelSelection;
        const instance = yield* registry.getInstance(pick.instanceId);
        if (!instance?.enabled || instance.instanceId !== pick.instanceId ||
            !(yield* threads.isProviderInstanceEnabledForProject({ projectId: parent.projectId, instanceId: pick.instanceId })))
          return yield* failure("That provider instance is not enabled for this project.");
        const provider = yield* instance.snapshot.getSnapshot;
        if (provider.instanceId !== pick.instanceId || !providerAvailable(provider))
          return yield* failure("That provider account is unavailable.");
        const model = provider.models.find(({ slug }) => slug === pick.model);
        if (!model || !optionsValid(pick, model.capabilities?.optionDescriptors))
          return yield* failure("The selected model or options are unavailable for that provider account.");
        const limit = currentLimit(parent);
        if (exceededDispatchModeLimit(limit, parent) !== undefined)
          return yield* failure("The source thread is above the managed approval limit.");
        if (provider.supportedRuntimeModes?.length && !provider.supportedRuntimeModes.includes(limit.runtimeMode))
          return yield* failure("That provider cannot run the source approval mode.");

        const result = yield* threads.dispatch({
          type: "delegated_task.request",
          commandId,
          parentThreadId: parent.id,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          title: input.title,
          task: input.task,
          modelSelection: pick,
          ...limit,
          createdBy: "agent",
          creationSource: "mcp",
          completionWake: "always",
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
        }).pipe(
          Effect.provideService(DispatchModeLimit, limit),
          wrap("V2 could not admit the delegated worker."),
        );
        const saved = findSpawn(result.storedEvents, parent.id, input);
        if (!saved?.childThreadId) return yield* failure("The delegation receipt does not match this task.");
        return yield* readWorker(yield* owned(parent, saved.childThreadId));
      }),
    ),
    get: readOwned,
    list: Effect.fn("AgentDelegation.list")(function* (invocation: McpInvocationScope) {
      const { caller } = yield* authorize(invocation);
      return yield* Effect.forEach(yield* family(caller), readWorker);
    }),
    wait: Effect.fn("AgentDelegation.wait")(function* (id: ThreadId, seconds: number, invocation: McpInvocationScope) {
      const { caller } = yield* authorize(invocation);
      const worker = yield* owned(caller, id);
      const afterSequence = yield* threads.getThreadEventSequence(worker.task.threadId).pipe(
        wrap("Could not start watching the worker."),
      );
      const initial = yield* readWorker(worker);
      if (!liveStatus(initial.status) || initial.status === "waiting") return initial;
      const next = yield* Stream.merge(
        threads.streamStoredEventsFrom({ afterSequence, threadId: id }).pipe(
          Stream.filter(({ event }) => event.type === "run.created" || event.type === "run.updated" ||
            event.type === "runtime-request.updated" || event.type === "thread.archived" || event.type === "thread.deleted"),
        ),
        threads.streamStoredEventsFrom({
          afterSequence, threadId: worker.task.threadId, eventType: "subagent.updated",
        }).pipe(Stream.filter(({ event }) => event.type === "subagent.updated" && event.payload.id === worker.task.id)),
      ).pipe(
        Stream.mapError(() => failure("Could not watch saved worker events.")),
        Stream.mapEffect(() => readOwned(id, invocation)),
        Stream.filter(({ status }) => status !== initial.status),
        Stream.runHead,
        Effect.timeoutOption(Duration.seconds(Math.min(60, Math.max(1, seconds)))),
        Effect.map(Option.flatten),
      );
      return Option.isSome(next) ? next.value : yield* readOwned(id, invocation);
    }),
    cancel: Effect.fn("AgentDelegation.cancel")(function* (id: ThreadId, invocation: McpInvocationScope) {
      const { caller: originalCaller } = yield* authorize(invocation);
      const originalWorker = yield* owned(originalCaller, id);
      const initial = yield* readWorker(originalWorker);
      if (!liveStatus(initial.status)) return initial;
      if (originalWorker.child.archivedAt !== null) return yield* unavailable();
      const commandId = yield* stableId("cancel", originalCaller.id, originalWorker.task.id + ":" + id);
      const { caller } = yield* authorize(invocation);
      const worker = yield* owned(caller, id);
      if (caller.id !== originalCaller.id || worker.task.id !== originalWorker.task.id ||
          worker.child.archivedAt !== null) return yield* unavailable();
      const current = yield* readWorker(worker);
      if (!liveStatus(current.status)) return current;
      const limit = currentLimit(caller);
      for (const child of [worker.child, ...(yield* family(worker.child, true)).map(({ child }) => child)]) {
        if (exceededDispatchModeLimit(limit, child) !== undefined)
          return yield* failure("A worker runs above your current approval or interaction mode.");
      }
      const reason = "Cancelled by the owning lead.";
      yield* threads.cancelDelegatedTask({
        parentThreadId: worker.task.threadId,
        taskId: worker.task.id,
        command: { type: "thread.stop", commandId, threadId: id, stopDelegatedTasks: false, reason },
        stopDescendants: (remoteDispatch) => threads.stopDelegatedTasks({
          threadId: id, commandId, reason, remoteDispatch,
        }),
      }).pipe(Effect.provideService(DispatchModeLimit, limit), wrap("V2 could not stop the delegated worker."));
      return yield* readOwned(id, invocation);
    }),
  };
});

export class AgentDelegation extends Context.Service<
  AgentDelegation, Effect.Success<typeof make>
>()("@j1code/server/mcp/AgentDelegation") {}

export const AgentDelegationLive = Layer.effect(AgentDelegation, make);
