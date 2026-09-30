import {
  AgentDelegationError,
  AgentDelegationResult,
  SpawnAgentInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { AgentDelegation } from "../../AgentDelegation.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [AgentDelegation, McpInvocationContext];
const WorkerInput = Schema.Struct({ threadId: ThreadId });

const Models = Tool.make("list_agent_models", {
  description:
    "List this environment's configured provider instances and exact model slugs for cross-provider delegation. Reads cached status without inference or account refresh. Only enabled, installed providers can be workers; authentication errors remain setup failures.",
  success: Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        instanceId: Schema.String,
        driver: Schema.String,
        name: Schema.String,
        enabled: Schema.Boolean,
        available: Schema.Boolean,
        authStatus: Schema.String,
        models: Schema.Array(Schema.Struct({ model: Schema.String, name: Schema.String })),
      }),
    ),
    limits: Schema.Struct({
      maxDepth: Schema.Int,
      maxActivePerLead: Schema.Int,
      maxWorkersPerTurn: Schema.Int,
    }),
  }),
  failure: AgentDelegationError,
  dependencies,
}).annotate(Tool.Readonly, true);

const Spawn = Tool.make("spawn_agent", {
  description:
    "Start a saved worker chat on ANY configured provider/model, including another harness. Use list_agent_models for instanceId and model. Returns immediately; collect its result with wait_agent/get_agent_result. Supply all needed context and task scope; conversation history is not automatically copied. The worker shares the lead's workspace and permission mode, so partition file ownership for parallel edits. Workers may delegate further within limits. Reuse requestId for retries. The default deadline is 10 minutes, maximum 30. Worker approval prompts remain for the user in its chat.",
  parameters: SpawnAgentInput,
  success: AgentDelegationResult,
  failure: AgentDelegationError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Get = Tool.make("get_agent_result", {
  description:
    "Read a worker's live status and bounded saved assistant output. Completed means the provider finished; verify its claims before declaring the user's goal complete. If waiting, direct the user to its Worker chat for approval or input. Full history is retained in that chat.",
  parameters: WorkerInput,
  success: AgentDelegationResult,
  failure: AgentDelegationError,
  dependencies,
}).annotate(Tool.Readonly, true);

const List = Tool.make("list_agents", {
  description:
    "List your delegated workers and results. The root lead may see its entire descendant tree; workers can see their own children. Does not expose other chats' workers.",
  success: Schema.Struct({ agents: Schema.Array(AgentDelegationResult) }),
  failure: AgentDelegationError,
  dependencies,
}).annotate(Tool.Readonly, true);

const Wait = Tool.make("wait_agent", {
  description:
    "Wait up to 60 seconds for a worker status change, then return its status and saved output. Call again while starting/running. Waiting means the worker needs the user's approval or input in its chat; this tool never approves it.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    timeoutSeconds: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
    ),
  }),
  success: AgentDelegationResult,
  failure: AgentDelegationError,
  dependencies,
}).annotate(Tool.Readonly, true);

const Cancel = Tool.make("cancel_agent", {
  description:
    "Stop your worker and its descendants, preserving all saved chats and evidence. Does not stop unrelated chats. Stopping the lead also cancels its descendant workers.",
  parameters: WorkerInput,
  success: AgentDelegationResult,
  failure: AgentDelegationError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AgentsToolkit = Toolkit.make(Models, Spawn, Get, List, Wait, Cancel);
