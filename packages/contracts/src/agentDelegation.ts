import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const AGENT_DELEGATION_ACTIVITY_KIND = "agent.delegation";
export const AGENT_DELEGATION_MAX_DEPTH = 3;
export const AGENT_DELEGATION_MAX_ACTIVE = 8;
export const AGENT_DELEGATION_MAX_TOTAL = 32;

export const AgentDelegationStatus = Schema.Literals([
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "timed-out",
  "interrupted",
]);
export type AgentDelegationStatus = typeof AgentDelegationStatus.Type;

export const SpawnAgentInput = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)).annotate({
    description:
      "A unique task key. Reuse the same key when retrying this spawn to avoid a duplicate worker.",
  }),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  modelSelection: ModelSelection,
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 1800 })),
  ),
});
export type SpawnAgentInput = typeof SpawnAgentInput.Type;

/** Durable linkage, stored as ordinary activities without a database-version change. */
export const AgentDelegationRecord = Schema.Struct({
  version: Schema.Literal(1),
  parentThreadId: ThreadId,
  rootThreadId: ThreadId,
  rootTurnKey: Schema.String,
  threadId: ThreadId,
  requestId: Schema.String,
  fingerprint: Schema.String,
  title: Schema.String,
  modelSelection: ModelSelection,
  depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AGENT_DELEGATION_MAX_DEPTH })),
  status: AgentDelegationStatus,
  createdAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  updatedAt: IsoDateTime,
  error: Schema.NullOr(Schema.String),
});
export type AgentDelegationRecord = typeof AgentDelegationRecord.Type;

export const AgentDelegationResult = Schema.Struct({
  threadId: ThreadId,
  parentThreadId: ThreadId,
  title: Schema.String,
  modelSelection: ModelSelection,
  status: AgentDelegationStatus,
  deadlineAt: IsoDateTime,
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type AgentDelegationResult = typeof AgentDelegationResult.Type;

export class AgentDelegationError extends Schema.TaggedError<AgentDelegationError>()(
  "AgentDelegationError",
  { message: Schema.String },
) {}
