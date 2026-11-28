import { assert, it } from "@effect/vitest";
import { DateTime, Effect, Ref } from "effect";

import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import { registerRoute, type RouteRequest } from "./routeState.ts";
import {
  LocalRouteNoticeWriter,
  makeRouteSourceNotifier,
  toLocalRouteNotice,
} from "./sourceActivity.ts";

const request: RouteRequest = {
  requestId: "notice-route",
  source: { environmentId: "local", projectId: "project", threadId: "thread" },
  destination: { environmentId: "local", projectId: "project", threadId: "receiving" },
  content: "First line\nSecond line",
  permissionCeiling: [],
  destinationPermissions: [],
  visited: [],
  maxHops: 1,
  ambiguous: false,
  mode: "auto",
  initiation: "manual",
};

it("builds a stable revision-scoped source notice and suppresses return-channel acknowledgements", () => {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
  const notice = toLocalRouteNotice({ state: registerRoute(request), revision: 4 }, now);
  assert.equal(notice?.id, "routing-notice:notice-route:4");
  assert.equal(notice?.summary, "First line");
  assert.deepEqual(notice?.source, request.source);
  assert.isNull(
    toLocalRouteNotice(
      {
        state: registerRoute({ ...request, feedbackFor: "original" }),
        revision: 1,
      },
      now,
    ),
  );
});

it.effect(
  "holds a local notice until an audit writer exists and preserves real external notices",
  () =>
    Effect.gen(function* () {
      const bridge = yield* ExternalRouteEndpoints;
      const externalNotices = yield* Ref.make(0);
      const localWrites = yield* Ref.make(0);
      const source = { ...request.source, threadId: "mausbot:origin" };
      const unregister = bridge.register({
        kind: "external-notice-fixture",
        accepts: (id) => id === source.threadId,
        source: () => Effect.succeed(null),
        notice: (notice) =>
          Effect.gen(function* () {
            assert.deepEqual(notice.endpoint, source);
            assert.equal(notice.requestId, request.requestId);
            yield* Ref.update(externalNotices, (count) => count + 1);
          }),
      });
      yield* Effect.addFinalizer(() => Effect.sync(unregister));
      const notifier = yield* makeRouteSourceNotifier;
      const local = { state: registerRoute(request), revision: 1 };
      assert.equal(yield* notifier(local), "held");
      assert.equal(
        yield* notifier({ ...local, state: registerRoute({ ...request, source }) }),
        "published",
      );
      assert.equal(
        yield* notifier({
          ...local,
          state: registerRoute({ ...request, source, feedbackFor: "old" }),
        }),
        "suppressed",
      );
      const withWriter = yield* makeRouteSourceNotifier.pipe(
        Effect.provideService(LocalRouteNoticeWriter, {
          write: (notice) =>
            Effect.gen(function* () {
              assert.equal(notice.id, "routing-notice:notice-route:1");
              yield* Ref.update(localWrites, (count) => count + 1);
            }),
        }),
      );
      assert.equal(yield* withWriter(local), "published");
      assert.equal(yield* Ref.get(externalNotices), 1);
      assert.equal(yield* Ref.get(localWrites), 1);
    }).pipe(Effect.scoped, Effect.provide(ExternalRouteEndpoints.layer)),
);
