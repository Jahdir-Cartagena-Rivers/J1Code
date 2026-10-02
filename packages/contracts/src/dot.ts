import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationThreadDetailPage, RuntimeMode } from "./orchestration.ts";
import { AgentDelegationResult, SpawnAgentInput } from "./agentDelegation.ts";

export const DotProjectGrant = Schema.Struct({
  projectId: ProjectId,
  read: Schema.Boolean,
  createTasks: Schema.Boolean,
  runtimeMode: RuntimeMode,
});
export type DotProjectGrant = typeof DotProjectGrant.Type;

export const DOT_OAUTH_SCOPES = [
  "dot:read",
  "dot:tasks",
  "dot:memory:read",
  "dot:memory:write",
] as const;
export type DotOAuthScope = (typeof DOT_OAUTH_SCOPES)[number];
export const DotHiveMindGrant = Schema.Struct({ read: Schema.Boolean, write: Schema.Boolean });

export const CreateDotConnectionInput = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  grants: Schema.Array(DotProjectGrant).check(Schema.isMaxLength(50)),
  hiveMind: Schema.optionalKey(DotHiveMindGrant),
  expiresInDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
});
export type CreateDotConnectionInput = typeof CreateDotConnectionInput.Type;

export const DotConnection = Schema.Struct({
  version: Schema.Literal(1),
  id: TrimmedNonEmptyString,
  label: Schema.String,
  grants: Schema.Array(DotProjectGrant),
  hiveMind: Schema.optionalKey(DotHiveMindGrant),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type DotConnection = typeof DotConnection.Type;

export const DotOAuthSetup = Schema.Struct({
  issuer: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  resource: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  redirectUri: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
export type DotOAuthSetup = typeof DotOAuthSetup.Type;

export const IssuedDotConnection = Schema.Struct({
  connection: DotConnection,
  credential: Schema.String,
  mcpPath: Schema.Literal("/dot/mcp"),
});

export const CreateDotTaskInput = Schema.Struct({
  projectId: ProjectId,
  ...SpawnAgentInput.fields,
});
export type CreateDotTaskInput = typeof CreateDotTaskInput.Type;

export const DotTaskInput = Schema.Struct({ projectId: ProjectId, threadId: ThreadId });
export const DotTaskQuery = Schema.Struct({
  ...DotTaskInput.fields,
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
});
export const DotTaskResult = Schema.Struct({
  ...AgentDelegationResult.fields,
  page: Schema.NullOr(OrchestrationThreadDetailPage),
});
export type DotTaskResult = typeof DotTaskResult.Type;

export class DotIntegrationError extends Schema.TaggedError<DotIntegrationError>()(
  "DotIntegrationError",
  { message: Schema.String },
) {}
