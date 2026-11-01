import { ProjectId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [OrchestrationEngineService, ProjectionSnapshotQuery, McpInvocationContext];
const Projects = Tool.make("list_chat_projects", {
  description:
    "List this environment's projects before routing a request from Home or another conversation. Project IDs and paths are environment-local.",
  success: Schema.Array(
    Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
  failure: Schema.String,
  dependencies,
}).annotate(Tool.Readonly, true);
const Handoff = Tool.make("handoff_to_project", {
  description:
    "Route a user request into a new saved project chat and start it there. Preserve the source conversation. Supply a self-contained request with relevant context and constraints, never secrets. Reuse requestId only for an identical retry. Return the supplied relative URL as a clickable Markdown link. This is a durable project chat, not a temporary worker. Ask for a destination only when ambiguous; never guess a workspace.",
  parameters: Schema.Struct({
    requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    projectId: ProjectId,
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    request: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  }),
  success: Schema.Struct({ threadId: ThreadId, url: Schema.String }),
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
export const HomeToolkit = Toolkit.make(Projects, Handoff);
