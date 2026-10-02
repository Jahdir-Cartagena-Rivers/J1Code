import {
  CreateDotConnectionInput,
  DotConnection,
  DotIntegrationError,
  type DotOAuthScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export class DotConnections extends Context.Service<
  DotConnections,
  {
    readonly create: (input: CreateDotConnectionInput) => Effect.Effect<
      {
        connection: DotConnection;
        credential: string;
        mcpPath: "/dot/mcp";
      },
      DotIntegrationError
    >;
    readonly list: Effect.Effect<ReadonlyArray<DotConnection>, DotIntegrationError>;
    readonly revoke: (id: string) => Effect.Effect<void, DotIntegrationError>;
    readonly resolve: (
      credential: string,
    ) => Effect.Effect<Option.Option<DotConnection>, DotIntegrationError>;
    readonly getActive: (id: string) => Effect.Effect<DotConnection, DotIntegrationError>;
  }
>()("t3/dot/DotConnections") {}

const unavailable = () =>
  new DotIntegrationError({ message: "Dot connection is unavailable, expired, or revoked." });
const storageError = () =>
  new DotIntegrationError({ message: "Could not read or persist the Dot connection." });
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(DotConnection));
const encode = Schema.encodeEffect(Schema.fromJsonString(DotConnection));
const decodeInput = Schema.decodeEffect(CreateDotConnectionInput);

/** Memory is a separate global grant; old project credentials acquire no memory access. */
export function connectionAllowsDotScope(connection: DotConnection, scope: DotOAuthScope): boolean {
  switch (scope) {
    case "dot:read":
      return connection.grants.some((grant) => grant.read);
    case "dot:tasks":
      return connection.grants.some((grant) => grant.createTasks);
    case "dot:memory:read":
      return connection.hiveMind?.read === true;
    case "dot:memory:write":
      return connection.hiveMind?.read === true && connection.hiveMind.write;
    case "dot:chat":
      return connection.chat === true;
  }
}

export const layer = Layer.effect(
  DotConnections,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const snapshots = yield* ProjectionSnapshotQuery;
    const hash = (credential: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(credential)).pipe(
        Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
        Effect.mapError(storageError),
      );
    const active = Effect.fn("DotConnections.active")(function* (connection: DotConnection) {
      const now = yield* DateTime.now;
      return (
        connection.revokedAt === null &&
        Date.parse(connection.expiresAt) > DateTime.toEpochMillis(now)
      );
    });
    const read = (rows: ReadonlyArray<{ connection_json: string }>) =>
      Effect.forEach(rows, (row) => decode(row.connection_json)).pipe(
        Effect.mapError(storageError),
      );
    const getActive = Effect.fn("DotConnections.getActive")(function* (id: string) {
      const rows = yield* sql<{
        connection_json: string;
      }>`SELECT connection_json FROM dot_connections WHERE id = ${id}`.pipe(
        Effect.mapError(storageError),
      );
      const connections = yield* read(rows);
      const connection = connections[0];
      if (!connection || !(yield* active(connection))) return yield* unavailable();
      return connection;
    });
    return DotConnections.of({
      getActive,
      create: Effect.fn("DotConnections.create")(function* (input) {
        input = yield* decodeInput(input).pipe(
          Effect.mapError(
            () => new DotIntegrationError({ message: "Invalid Dot connection settings." }),
          ),
        );
        if (new Set(input.grants.map((grant) => grant.projectId)).size !== input.grants.length)
          return yield* new DotIntegrationError({
            message: "Each project can be granted only once.",
          });
        if (input.hiveMind?.write && !input.hiveMind.read)
          return yield* new DotIntegrationError({
            message: "Hive Mind write access requires read access.",
          });
        if (!input.grants.length && !input.hiveMind?.read && !input.chat)
          return yield* new DotIntegrationError({
            message: "Choose native chat, project, or Hive Mind access.",
          });
        for (const grant of input.grants) {
          if (!grant.read && !grant.createTasks)
            return yield* new DotIntegrationError({
              message: "Choose read access or task creation for each project.",
            });
          const project = yield* snapshots
            .getProjectShellById(grant.projectId)
            .pipe(Effect.mapError(storageError));
          if (Option.isNone(project))
            return yield* new DotIntegrationError({ message: "A granted project does not exist." });
        }
        const now = yield* DateTime.now;
        const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(storageError));
        const credential = yield* crypto.randomBytes(32).pipe(
          Effect.map((bytes) => `j1-dot-${Buffer.from(bytes).toString("base64url")}`),
          Effect.mapError(storageError),
        );
        const connection: DotConnection = {
          version: 1,
          id,
          label: input.label,
          grants: input.grants,
          ...(input.hiveMind ? { hiveMind: input.hiveMind } : {}),
          ...(input.chat !== undefined ? { chat: input.chat } : {}),
          createdAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { days: input.expiresInDays })),
          revokedAt: null,
        };
        const tokenHash = yield* hash(credential);
        const json = yield* encode(connection).pipe(Effect.mapError(storageError));
        yield* sql`INSERT INTO dot_connections (id, token_hash, connection_json) VALUES (${id}, ${tokenHash}, ${json})`.pipe(
          Effect.mapError(storageError),
        );
        return { connection, credential, mcpPath: "/dot/mcp" };
      }),
      list: sql<{
        connection_json: string;
      }>`SELECT connection_json FROM dot_connections ORDER BY id`.pipe(
        Effect.mapError(storageError),
        Effect.flatMap(read),
      ),
      revoke: Effect.fn("DotConnections.revoke")(function* (id) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                connection_json: string;
              }>`SELECT connection_json FROM dot_connections WHERE id = ${id}`;
              const records = yield* read(rows);
              const connection = records[0];
              if (!connection || connection.revokedAt !== null) return;
              const revokedAt = DateTime.formatIso(yield* DateTime.now);
              const json = yield* encode({ ...connection, revokedAt });
              yield* sql`UPDATE dot_connections SET connection_json = ${json} WHERE id = ${id}`;
              // The chat service expires these rows, marks undelivered messages, and removes secrets.
              yield* sql`UPDATE dot_chat_subscriptions SET expires_at = 0 WHERE connection_id = ${id}`;
            }),
          )
          .pipe(Effect.mapError(storageError));
      }),
      resolve: Effect.fn("DotConnections.resolve")(function* (credential) {
        if (!credential.startsWith("j1-dot-") || credential.length > 128) return Option.none();
        const tokenHash = yield* hash(credential);
        const rows = yield* sql<{
          connection_json: string;
        }>`SELECT connection_json FROM dot_connections WHERE token_hash = ${tokenHash}`.pipe(
          Effect.mapError(storageError),
        );
        const records = yield* read(rows);
        const connection = records[0];
        return connection && (yield* active(connection)) ? Option.some(connection) : Option.none();
      }),
    });
  }),
);
