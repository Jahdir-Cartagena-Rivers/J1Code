// @effect-diagnostics nodeBuiltinImport:off - reads the connection file the Hive Mind app writes for local clients.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

/**
 * Hive Mind is a separate application. J1 Code only finds it through
 * `~/.hive-mind/connection.json` (or HIVE_MIND_CONNECTION_FILE) and talks to its
 * local HTTP API; without that file every operation reports that it is not running.
 */
export class HiveMindError extends Schema.TaggedError<HiveMindError>()("HiveMindError", {
  message: Schema.String,
}) {}

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
export const HiveMindRecallResult = Schema.Struct({
  memories: Schema.Array(HiveMindMemory),
  retrieval: Schema.optionalKey(HiveMindRetrieval),
});
export const HiveMindRememberResult = Schema.Struct({ memory: HiveMindMemory });
export const HiveMindForgetResult = Schema.Struct({ removed: Schema.Boolean });
export const HiveMindStatus = Schema.Struct({
  records: Schema.Number,
  skills: Schema.Number,
  pendingIndex: Schema.Number,
  phase: Schema.String,
  lastSync: Schema.NullOr(Schema.String),
  issues: Schema.Array(Schema.String),
});

const Connection = Schema.fromJsonString(
  Schema.Struct({ origin: Schema.String, token: Schema.String }),
);
const decodeConnection = Schema.decodeUnknownSync(Connection);
const NOT_RUNNING =
  "Hive Mind is not running. Start the Hive Mind app on this machine to use shared memory.";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isHiveMindError = Schema.is(HiveMindError);

const connectionFile = () =>
  process.env["HIVE_MIND_CONNECTION_FILE"] ??
  NodePath.join(NodeOS.homedir(), ".hive-mind", "connection.json");

// Synchronous on purpose: the file is tiny, and it keeps every turn's scheduling deterministic.
const readConnection = Effect.try({
  try: () => {
    const connection = decodeConnection(NodeFS.readFileSync(connectionFile(), "utf8"));
    // The bearer token only ever goes to a service on this machine.
    if (!LOOPBACK.has(new URL(connection.origin).hostname)) throw new Error("not loopback");
    return connection;
  },
  catch: () => new HiveMindError({ message: NOT_RUNNING }),
});

/** One authenticated request to the Hive Mind service, decoded as `schema`; a missing body means GET. */
const call = <S extends Schema.Decoder<unknown, never>>(
  schema: S,
  route: string,
  body?: unknown,
  timeoutMs = 60_000,
) =>
  Effect.gen(function* () {
    const connection = yield* readConnection;
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.make(body === undefined ? "GET" : "POST")(
      `${connection.origin.replace(/\/$/u, "")}${route}`,
    ).pipe(HttpClientRequest.bearerToken(connection.token));
    const request = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300)
      return yield* new HiveMindError({ message: `Hive Mind returned HTTP ${response.status}.` });
    // The app is versioned separately, so replies are checked rather than trusted.
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
  }).pipe(
    Effect.timeout(timeoutMs),
    Effect.mapError((error) =>
      isHiveMindError(error) ? error : new HiveMindError({ message: NOT_RUNNING }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  );

export const recallHiveMind = (query: string, project?: string) =>
  call(HiveMindRecallResult, "/v1/search", { query, ...(project ? { project } : {}) });
export const rememberHiveMind = (input: {
  scope: "general" | "project";
  subject: string;
  fact: string;
  project?: string | undefined;
  sourceThreadId: string;
}) =>
  call(HiveMindRememberResult, "/v1/remember", {
    ...input,
    project: input.project ?? undefined,
  });
export const forgetHiveMind = (id: string) => call(HiveMindForgetResult, "/v1/forget", { id });
export const hiveMindStatus = () => call(HiveMindStatus, "/v1/status");
export const syncHiveMind = () => call(HiveMindStatus, "/v1/sync", {});

/** Background notes for a new turn. Never fails and never waits long: no Hive Mind means no context. */
export const hiveMindContext = (query: string, projects: ReadonlyArray<string>) =>
  call(Schema.Struct({ context: Schema.String }), "/v1/context", { query, projects }, 1_500).pipe(
    Effect.map((result) => result.context),
    Effect.orElseSucceed(() => ""),
  );
