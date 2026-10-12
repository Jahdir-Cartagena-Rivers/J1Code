import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as ServerConfig from "../../../config.ts";
import {
  HiveMindError,
  HiveMindForgetResult,
  HiveMindMemory,
  HiveMindRecallResult,
  HiveMindRememberResult,
  HiveMindRetrieval,
  HiveMindStatus,
} from "../../../hiveMind/connector.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export { HiveMindError, HiveMindMemory, HiveMindRetrieval };

const dependencies = [ServerConfig.ServerConfig, McpInvocationContext];
const Recall = Tool.make("hive_mind_recall", {
  description:
    "Search the shared J1 Code Hive Mind across providers and projects. Use when a person, project, concept, preference, or past decision may have been explained in another chat. Project is an optional ranking hint; cross-project matches remain available.",
  parameters: Schema.Struct({
    query: Schema.String,
    project: Schema.optional(Schema.String),
  }),
  success: HiveMindRecallResult,
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
  success: HiveMindRememberResult,
  failure: HiveMindError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const Forget = Tool.make("hive_mind_forget", {
  description:
    "Remove a Hive Mind fact by its id after the user asks to forget it. Find its id with hive_mind_recall first.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: HiveMindForgetResult,
  failure: HiveMindError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);

const Status = Tool.make("hive_mind_status", {
  description:
    "Inspect Hive Mind's memory count, skills catalog and index state. Configuration belongs to the Hive Mind app.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: HiveMindStatus,
  failure: HiveMindError,
  dependencies,
}).annotate(Tool.Readonly, true);

const Sync = Tool.make("hive_mind_sync", {
  description:
    "Synchronize Hive Mind vault edits, skills catalog and semantic index. Reports conflicts and pending work; never runs skill instructions.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: HiveMindStatus,
  failure: HiveMindError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const HiveMindToolkit = Toolkit.make(Recall, Remember, Forget, Status, Sync);
