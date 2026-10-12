// @effect-diagnostics nodeBuiltinImport:off - connection files in a temp directory.
// @effect-diagnostics preferSchemaOverJson:off - fixture JSON.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { forgetHiveMind, hiveMindContext, recallHiveMind, rememberHiveMind } from "./connector.ts";
import { startFakeHiveMind } from "./fakeService.ts";

const restore = process.env["HIVE_MIND_CONNECTION_FILE"];
afterEach(() => {
  if (restore === undefined) delete process.env["HIVE_MIND_CONNECTION_FILE"];
  else process.env["HIVE_MIND_CONNECTION_FILE"] = restore;
});

describe("Hive Mind plugin connection", () => {
  it.effect(
    "reports that Hive Mind is not running, and adds no context, when there is no connection",
    () =>
      Effect.gen(function* () {
        process.env["HIVE_MIND_CONNECTION_FILE"] = NodePath.join(
          NodeOS.tmpdir(),
          "missing-hive.json",
        );
        expect(yield* hiveMindContext("anything", [])).toBe("");
        const failure = yield* recallHiveMind("anything").pipe(Effect.flip);
        expect(failure.message).toContain("Hive Mind is not running");
      }),
  );

  it.effect("never sends the token to a non-loopback address", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hive-conn-")),
      );
      const file = NodePath.join(directory, "connection.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          file,
          JSON.stringify({ origin: "http://example.com", token: "t".repeat(32) }),
        ),
      );
      process.env["HIVE_MIND_CONNECTION_FILE"] = file;
      const failure = yield* recallHiveMind("anything").pipe(Effect.flip);
      expect(failure.message).toContain("not running");
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );

  it.effect("round-trips memories and context through the service", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hive = yield* Effect.acquireRelease(Effect.promise(startFakeHiveMind), (fake) =>
          Effect.promise(() => fake.close()),
        );
        const { memory } = yield* rememberHiveMind({
          scope: "project",
          project: "Nebula",
          subject: "Cooling",
          fact: "Copper fins dissipate heat.",
          sourceThreadId: "thread-1",
        });
        expect(memory.sourceThreadId).toBe("thread-1");
        expect((yield* recallHiveMind("copper")).memories.map((m) => m.id)).toEqual([memory.id]);
        expect(yield* hiveMindContext("copper fins", ["Nebula"])).toContain("Copper fins");
        expect(hive.contextRequests[0]?.projects).toEqual(["Nebula"]);
        expect((yield* forgetHiveMind(memory.id)).removed).toBe(true);
        expect((yield* recallHiveMind("copper")).memories).toEqual([]);
      }),
    ),
  );
});
