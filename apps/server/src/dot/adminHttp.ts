import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  DotIntegrationError,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpEffect, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DotConnections } from "./DotConnections.ts";
import { DotOAuth } from "./DotOAuth.ts";

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

export const layer = HttpApiBuilder.group(EnvironmentHttpApi, "dot", (handlers) =>
  Effect.gen(function* () {
    const connections = yield* DotConnections;
    const oauth = yield* DotOAuth;
    const snapshots = yield* ProjectionSnapshotQuery;
    return handlers
      .handle("oauthSetup", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthAccessReadScope);
          yield* noStore;
          return Option.getOrNull(
            yield* oauth.readSetup.pipe(
              Effect.mapError(
                () => new DotIntegrationError({ message: "Could not read Dot OAuth setup." }),
              ),
            ),
          );
        }),
      )
      .handle("configureOAuth", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* noStore;
          return yield* oauth.configure(payload).pipe(
            Effect.mapError(
              () =>
                new DotIntegrationError({
                  message:
                    "Dot OAuth requires an HTTPS issuer origin, resource URL, and exact client callback URL.",
                }),
            ),
          );
        }),
      )
      .handle("connections", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthAccessReadScope);
          yield* noStore;
          return yield* connections.list;
        }),
      )
      .handle("projects", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* noStore;
          const projects = yield* snapshots
            .getProjectShells()
            .pipe(
              Effect.mapError(
                () => new DotIntegrationError({ message: "Could not list projects." }),
              ),
            );
          return projects.map((project) => ({ id: project.id, title: project.title }));
        }),
      )
      .handle("createConnection", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          if (payload.grants.some((grant) => grant.read))
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          if (payload.grants.some((grant) => grant.createTasks))
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* noStore;
          return yield* connections.create(payload);
        }),
      )
      .handle("revokeConnection", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* noStore;
          yield* connections.revoke(payload.id);
          return { revoked: true };
        }),
      );
  }),
);
