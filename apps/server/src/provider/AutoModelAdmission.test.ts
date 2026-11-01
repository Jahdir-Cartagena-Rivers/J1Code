import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { AutoModelInput } from "@t3tools/shared/autoModel";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import migration from "../persistence/Migrations/061_AutoModelAdmissions.ts";
import { makeAutoModelAdmission } from "./AutoModelAdmission.ts";

it.effect("does not acknowledge an admission when durable storage rejects it", () =>
  test((service, sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TRIGGER reject_admission BEFORE INSERT ON auto_model_admissions
      BEGIN SELECT RAISE(ABORT, 'storage failure'); END`;
      yield* Effect.flip(service.admit({ threadId: "thread", requestId: "failure", input }));
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(0);
    }),
  ),
);

const fast = {
  provider: "codex",
  instanceId: "one",
  modelId: "fast",
  options: [{ id: "reasoning", value: "low" }],
};
const deep = { provider: "codex", instanceId: "two", modelId: "deep" };
const input: AutoModelInput = {
  defaults: { fast, deep },
  candidates: [fast, deep].map((ref) => ({
    ref,
    available: true,
    tools: true,
    images: true,
    contextWindow: 1000,
  })),
  task: {
    id: "task",
    complexity: "simple",
    highRisk: false,
    crossComponent: false,
    requiresTools: true,
    requiresImages: false,
    requiredContextTokens: 100,
  },
  safeBoundary: true,
};
type AdmissionService = Effect.Success<typeof makeAutoModelAdmission>;
type Admission = ReturnType<AdmissionService["admit"]>;
const test = (
  body: (
    service: AdmissionService,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<
    void,
    Effect.Error<Admission> | Effect.Success<Admission>,
    SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    yield* migration;
    yield* body(yield* makeAutoModelAdmission, yield* SqlClient.SqlClient);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

it.effect(
  "journals a measured receipt, survives service recreation, and keeps retries stable",
  () =>
    test((service, sql) =>
      Effect.gen(function* () {
        const request = { threadId: "thread", requestId: "request", input };
        const receipt = yield* service.admit(request);
        expect(receipt.pin.ref).toEqual(fast);
        expect(receipt.resolverDurationMs).toBeGreaterThanOrEqual(0);
        const restarted = yield* makeAutoModelAdmission;
        expect(
          yield* restarted.admit({
            ...request,
            input: { ...input, defaults: { fast: deep, deep } },
          }),
        ).toEqual(receipt);
        expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(1);
        const failure = yield* Effect.flip(
          restarted.admit({
            ...request,
            input: { ...input, task: { ...input.task, id: "different" } },
          }),
        );
        expect(failure).toMatchObject({ reason: "retry-identity-conflict" });
      }),
    ),
);

it.effect("retains task pins across policy edits and escalates only at safe boundaries", () =>
  test((service) =>
    Effect.gen(function* () {
      const admit = (requestId: string, override: Partial<AutoModelInput> = {}) =>
        service.admit({ threadId: "thread", requestId, input: { ...input, ...override } });
      yield* admit("first");
      expect((yield* admit("next", { defaults: { fast: deep, deep } })).pin.ref).toEqual(fast);
      const deferred = yield* admit("defer", { requestEscalation: true, safeBoundary: false });
      expect(deferred.reason).toBe("escalation-deferred");
      expect(deferred.pin.ref).toEqual(fast);
      const escalated = yield* admit("escalate", { requestEscalation: true });
      expect(escalated.pin.ref).toEqual(deep);
      expect(escalated.reason).toBe("escalated");
    }),
  ),
);

it.effect(
  "fails without journal side effects on unavailable, image-unsupported, and unknown context candidates",
  () =>
    test((service, sql) =>
      Effect.gen(function* () {
        for (const candidates of [
          input.candidates.map((c) => ({ ...c, available: false as const })),
          input.candidates.map((c) => ({ ...c, images: false as const })),
          input.candidates.map((c) => ({ ...c, contextWindow: "unknown" as const })),
        ]) {
          yield* Effect.flip(
            service.admit({
              threadId: "thread",
              requestId: "blocked",
              input: { ...input, candidates, task: { ...input.task, requiresImages: true } },
            }),
          );
          expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(0);
        }
      }),
    ),
);

it.effect("uses whole project override and revalidates retry availability", () =>
  test((service, sql) =>
    Effect.gen(function* () {
      const request = {
        threadId: "thread",
        requestId: "project",
        input: { ...input, projectOverride: { fast: deep, deep } },
      };
      expect((yield* service.admit(request)).pin.ref).toEqual(deep);
      const error = yield* Effect.flip(
        service.admit({ ...request, input: { ...request.input, candidates: [] } }),
      );
      expect(error).toMatchObject({ reason: "retry-model-ineligible" });
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(1);
    }),
  ),
);

it.effect("rejects options not validated by the exact-instance candidate producer", () =>
  test((service, sql) =>
    Effect.gen(function* () {
      const request = { threadId: "thread", requestId: "options", input };
      const candidates = input.candidates.map((candidate) => ({
        ...candidate,
        ref: { ...candidate.ref, options: [] },
      }));
      expect(
        yield* Effect.flip(service.admit({ ...request, input: { ...input, candidates } })),
      ).toMatchObject({ reason: "selected-options-unvalidated" });
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(0);
      yield* service.admit(request);
      expect(
        yield* Effect.flip(service.admit({ ...request, input: { ...input, candidates } })),
      ).toMatchObject({ reason: "retry-model-ineligible" });
    }),
  ),
);

it.effect("rejects an old request after a durable task escalation", () =>
  test((service, sql) =>
    Effect.gen(function* () {
      const first = { threadId: "thread", requestId: "first", input };
      yield* service.admit(first);
      yield* service.admit({
        ...first,
        requestId: "deep",
        input: { ...input, requestEscalation: true },
      });
      expect(yield* Effect.flip(service.admit(first))).toMatchObject({
        reason: "retry-selection-superseded",
      });
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(2);
    }),
  ),
);
