import {
  OrchestrationProjectShell,
  EnvironmentId,
  OrchestrationV2ThreadShellJson,
} from "@j1code/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Arbitrary from "effect/Arbitrary";

import { makeStoredShellSnapshotEncoder } from "./shellCacheEncoding.ts";
import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
} from "./orchestrationCache.ts";

// Generated values can hold untrimmed strings, which a decoded value never
// has. One encode and decode gives a value a client can hold; values that
// fail are dropped. Size 30 makes the generator fill optional fields.
const sampleDecoded = <S extends Schema.Constraint>(schema: S) =>
  Effect.gen(function* () {
    const encode = Schema.encodeEffect(schema);
    const decode = Schema.decodeEffect(schema);
    const generated = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
      count: 1000,
      size: 30,
    });
    const decoded = yield* Effect.forEach(generated, (value) =>
      encode(value).pipe(Effect.flatMap(decode), Effect.option),
    );
    return Arr.getSomes(decoded);
  });
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(StoredOrchestrationShellSnapshot));

describe("stored shell cache generated encoding", () => {
  it.effect("matches the Schema encoding of a generated snapshot", () =>
    Effect.gen(function* () {
      const threads = yield* sampleDecoded(OrchestrationV2ThreadShellJson);
      const projects = yield* sampleDecoded(OrchestrationProjectShell);
      const midpoint = Math.ceil(threads.length / 2);
      const snapshot: (typeof StoredOrchestrationShellSnapshot.Type)["snapshot"] = {
        schemaVersion: 1,
        snapshotSequence: 1,
        // The generator rarely makes monogram icons, and they are the one
        // project field whose encoding differs from the decoded value.
        projects: projects.map((project, index) =>
          index % 2 === 0
            ? { ...project, projectIcon: { kind: "monogram", text: "J1", color: "blue" } }
            : project,
        ),
        threads: threads.slice(0, midpoint),
        archivedThreads: threads.slice(midpoint),
      };

      expect(snapshot.threads.length).toBeGreaterThan(0);
      expect(snapshot.archivedThreads.length).toBeGreaterThan(0);
      expect(projects.length).toBeGreaterThan(0);
      const stored = {
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId: EnvironmentId.make("generated-cache-environment"),
        snapshot,
      };
      expect(yield* makeStoredShellSnapshotEncoder({ yieldToHost: Effect.void })(stored)).toEqual(
        yield* encodeSnapshot(stored),
      );
    }),
  );
});
