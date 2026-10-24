// @effect-diagnostics nodeBuiltinImport:off - host-owned credential discovery for the selected memory authority.
import * as path from "node:path";
import * as os from "node:os";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { readHiveConfig } from "./config.ts";
import { readOptional } from "./files.ts";
const Connection = Schema.Struct({ origin: Schema.String, token: Schema.String });
export type HiveConnection = typeof Connection.Type;
export class HiveTransportError extends Schema.TaggedError<HiveTransportError>()(
  "HiveTransportError",
  { message: Schema.String },
) {}

export async function selectedHiveConnection(file: string): Promise<HiveConnection | null> {
  const config = await readHiveConfig(file);
  if (config.backend?.mode !== "external") return null;
  const location =
    config.backend.connectionFile ?? path.join(os.homedir(), ".hive-mind", "connection.json");
  let connection: HiveConnection;
  try {
    connection = Schema.decodeUnknownSync(Connection)(
      JSON.parse((await readOptional(location)) ?? "null"),
    );
  } catch {
    throw new Error(
      "External Hive Mind connection is unavailable. Select Built-in to use J1's own store, or repair the connection file on this server.",
    );
  }
  const url = new URL(connection.origin);
  if (
    !(
      ["https:"].includes(url.protocol) ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    connection.token.length < 32 ||
    /\s/u.test(connection.token)
  )
    throw new Error(
      "Invalid Hive Mind connection. Use a loopback HTTP or HTTPS origin and a bearer credential in the connection file.",
    );
  return { origin: url.origin, token: connection.token };
}
export async function requestHive(
  connection: HiveConnection,
  route: string,
  body?: unknown,
): Promise<unknown> {
  let rejectedStatus: number | undefined;
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const base = HttpClientRequest.setHeader(
          HttpClientRequest.make(body === undefined ? "GET" : "POST")(
            `${connection.origin}${route}`,
          ),
          "authorization",
          `Bearer ${connection.token}`,
        );
        const request = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);
        const response = yield* client.execute(request);
        if (response.status < 200 || response.status >= 300) {
          rejectedStatus = response.status;
          return yield* new HiveTransportError({
            message: `Hive Mind rejected the operation (HTTP ${response.status}).`,
          });
        }
        return yield* response.json;
      }).pipe(
        Effect.timeout(5000),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
    );
  } catch {
    throw new Error(
      rejectedStatus
        ? `External Hive Mind rejected the operation (HTTP ${rejectedStatus}); no fallback memory writes were made.`
        : "External Hive Mind is unavailable; no fallback memory writes were made.",
    );
  }
}
