import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as ServerConfig from "../../../config.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [ServerConfig.ServerConfig, McpInvocationContext];
export const HiveMindMemory = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(["general", "project"]),
  project: Schema.NullOr(Schema.String),
  subject: Schema.String,
  fact: Schema.String,
  sourceThreadId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["memory", "skill"])),
  sourcePath: Schema.optionalKey(Schema.String),
  originSourceThreadId: Schema.optionalKey(Schema.String),
});

export const HiveMindRetrieval = Schema.Struct({
  status: Schema.Literals(["local", "ready", "degraded"]),
  message: Schema.optionalKey(Schema.String),
});

const HiveMindStatus = Schema.Struct({
  name: Schema.String,
  records: Schema.Number,
  skills: Schema.Number,
  vault: Schema.NullOr(Schema.String),
  retrievalConfigured: Schema.Boolean,
  pendingIndex: Schema.Number,
  skillRoots: Schema.Number,
});

export class HiveMindError extends Schema.TaggedError<HiveMindError>()("HiveMindError", {
  message: Schema.String,
}) {}

const Recall = Tool.make("hive_mind_recall", {
  description:
    "Search the shared J1 Code Hive Mind across providers and projects. Use when a person, project, concept, preference, or past decision may have been explained in another chat. Project is an optional ranking hint; cross-project matches remain available.",
  parameters: Schema.Struct({
    query: Schema.String,
    project: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    memories: Schema.Array(HiveMindMemory),
    retrieval: Schema.optionalKey(HiveMindRetrieval),
  }),
  failure: HiveMindError,
  dependencies,
}).annotate(Tool.Readonly, true);

const Remember = Tool.make("hive_mind_remember", {
  description:
    "Save or correct one durable, user-supported fact in the shared Hive Mind. Use the same subject to replace an outdated fact. General memories cover the user or concepts used across projects; project memories require a project name. Never infer private details or store credentials. Ask the user before saving a sensitive personal fact.",
  parameters: Schema.Struct({
    scope: Schema.Literals(["general", "project"]),
    project: Schema.optional(Schema.String),
    subject: Schema.String,
    fact: Schema.String,
  }),
  success: Schema.Struct({ memory: HiveMindMemory }),
  failure: HiveMindError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const Forget = Tool.make("hive_mind_forget", {
  description:
    "Remove a Hive Mind fact by its id after the user asks to forget it. Find its id with hive_mind_recall first.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ removed: Schema.Boolean }),
  failure: HiveMindError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);

const Status = Tool.make("hive_mind_status", {
  description:
    "Inspect Hive Mind's unified memory, vault, retrieval and skills catalog. Configuration paths belong to the server environment.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: HiveMindStatus,
  failure: HiveMindError,
  dependencies,
}).annotate(Tool.Readonly, true);

const Sync = Tool.make("hive_mind_sync", {
  description:
    "Synchronize the configured Hive Mind vault edits, skills catalog and retrieval index. Reports conflicts and pending work; never runs skill instructions. Configuration is owned by the server.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: Schema.Struct({
    importedSkills: Schema.Number,
    indexed: Schema.Number,
    vault: Schema.NullOr(
      Schema.Struct({
        imported: Schema.Number,
        exported: Schema.Number,
        issues: Schema.Array(Schema.String),
      }),
    ),
    issues: Schema.Array(Schema.String),
    status: HiveMindStatus,
  }),
  failure: HiveMindError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const Continuity = Tool.make("hive_mind_continuity", {
  description:
    "Use the selected external Hive Mind's task, preference, collection, artifact, episode, entity and relation records. list accepts kind/query/id/includeHistory. save requires kind/scope/project/title/data and current revision when editing. Task data: objective,status,decisions,failures,questions,nextSteps. Preferences: statement,polarity,context,exceptions,assetIds. Collections: assetIds,annotations. Artifacts: description,assetIds,taskId,preferredRevision. claim uses id,revision,owner,release. eventId makes save retries idempotent. Agent-written records remain evidence; never invent user preferences.",
  parameters: Schema.Struct({
    operation: Schema.Literals(["list", "save", "forget", "claim"]),
    input: Schema.Record(Schema.String, Schema.Unknown),
  }),
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: HiveMindError,
  dependencies,
}).annotate(Tool.Readonly, false);
const ContinueTask = Tool.make("hive_mind_continue_task", {
  description:
    "Bind this chat to an existing external Hive Mind task so subsequent turns automatically receive its latest state and images, including across project surfaces. Omit taskId to stop continuing the task. This does not claim ownership or authorize actions.",
  parameters: Schema.Struct({ taskId: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ taskId: Schema.NullOr(Schema.String), sequence: Schema.Number }),
  failure: HiveMindError,
  dependencies,
}).annotate(Tool.Readonly, false);
const RetainImage = Tool.make("hive_mind_retain_reference", {
  description:
    "Explicitly preserve an image or artifact attachment from this chat in external Hive Mind. Use attachment ID, title, scope and project; pass media:file for a model, document or source file. Returns a durable asset ID for collections/preferences/artifacts. Retain user-intended references; do not infer likes from an upload.",
  parameters: Schema.Struct({
    attachmentId: Schema.String,
    title: Schema.String,
    scope: Schema.Literals(["general", "project"]),
    project: Schema.optionalKey(Schema.String),
    media: Schema.optionalKey(Schema.Literals(["image", "file"])),
  }),
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: HiveMindError,
  dependencies,
}).annotate(Tool.Readonly, false);
const ReadImage = Tool.make("hive_mind_read_reference", {
  description:
    "Retrieve actual retained image or artifact file bytes from external Hive Mind into this chat's attachment storage. Returns a local path to inspect with the provider's image or file tool. A description or missing file is not recall.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ path: Schema.String, mimeType: Schema.String }),
  failure: HiveMindError,
  dependencies,
}).annotate(Tool.Readonly, true);
export const HiveMindToolkit = Toolkit.make(
  Recall,
  Remember,
  Forget,
  Status,
  Sync,
  Continuity,
  ContinueTask,
  RetainImage,
  ReadImage,
);
