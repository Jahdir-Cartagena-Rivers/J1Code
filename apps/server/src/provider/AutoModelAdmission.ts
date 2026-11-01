import { ProviderOptionSelections } from "@t3tools/contracts";
import {
  measureAutoModelDecision,
  resolveAutoModel,
  type AutoModelInput,
  type AutoModelPin,
  type AutoModelRef,
} from "@t3tools/shared/autoModel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Durable task pins are revalidated by the serialized engine before provider dispatch.
const Ref = Schema.Struct({
  provider: Schema.String,
  instanceId: Schema.String,
  modelId: Schema.String,
  options: Schema.optionalKey(ProviderOptionSelections),
});
const Receipt = Schema.Struct({
  type: Schema.Literal("auto-model.admitted"),
  threadId: Schema.String,
  requestId: Schema.String,
  revision: Schema.Int,
  pin: Schema.Struct({
    taskId: Schema.String,
    ref: Ref,
    mode: Schema.Literals(["fast", "deep", "manual"]),
  }),
  reason: Schema.String,
  resolverDurationMs: Schema.NullOr(Schema.Number),
});
export class AutoModelAdmissionError extends Schema.TaggedError<AutoModelAdmissionError>()(
  "AutoModelAdmissionError",
  {
    reason: Schema.String,
    exclusions: Schema.optional(Schema.Array(Schema.String)),
  },
) {}
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const receiptCodec = Schema.fromJsonString(Receipt);
const encodeReceipt = Schema.encodeEffect(receiptCodec);
const decodeReceipt = Schema.decodeUnknownEffect(receiptCodec);

const selectionKey = (ref: AutoModelRef) =>
  JSON.stringify([...(ref.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)));

// Candidate options are an assertion by the server producer that these exact
// values were validated against the live provider descriptor.
const optionsValidated = (input: AutoModelInput, ref: AutoModelRef) => {
  const matches = input.candidates.filter(
    (candidate) =>
      candidate.ref.provider === ref.provider &&
      candidate.ref.instanceId === ref.instanceId &&
      candidate.ref.modelId === ref.modelId,
  );
  return matches.length === 1 && selectionKey(matches[0]!.ref) === selectionKey(ref);
};
export const makeAutoModelAdmission = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const admit = Effect.fn("AutoModelAdmission.admit")(function* (request: {
    readonly threadId: string;
    readonly requestId: string;
    // Server-derived requirements and current exact-instance metadata only.
    readonly input: Omit<AutoModelInput, "pin" | "manual">;
  }) {
    const { threadId, requestId } = request;
    const input = request.input;
    const identity = yield* encodeIdentity({
      task: input.task,
      escalation: input.requestEscalation === true,
    });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const retries = yield* sql<{ request_identity: string; receipt_json: string }>`
        SELECT request_identity, receipt_json FROM auto_model_admissions
        WHERE thread_id = ${threadId} AND request_id = ${requestId}`;
        const retry = retries[0];
        if (retry) {
          if (retry.request_identity !== identity)
            return yield* new AutoModelAdmissionError({ reason: "retry-identity-conflict" });
          const receipt = yield* decodeReceipt(retry.receipt_json);
          const latest = yield* sql<{ receipt_json: string }>`SELECT receipt_json
          FROM auto_model_admissions WHERE thread_id = ${threadId}
          AND task_id = ${input.task.id} ORDER BY revision DESC LIMIT 1`;
          const current = latest[0] ? yield* decodeReceipt(latest[0].receipt_json) : receipt;
          if (
            current.pin.ref.provider !== receipt.pin.ref.provider ||
            current.pin.ref.instanceId !== receipt.pin.ref.instanceId ||
            current.pin.ref.modelId !== receipt.pin.ref.modelId ||
            selectionKey(current.pin.ref) !== selectionKey(receipt.pin.ref)
          )
            return yield* new AutoModelAdmissionError({ reason: "retry-selection-superseded" });
          // A receipt is stable, but it is never proof that its provider is still available.
          const checked = resolveAutoModel({
            ...input,
            pin: receipt.pin,
            requestEscalation: false,
            safeBoundary: false,
          });
          if (checked.status !== "selected" || !optionsValidated(input, receipt.pin.ref))
            return yield* new AutoModelAdmissionError({ reason: "retry-model-ineligible" });
          return receipt;
        }
        const rows = yield* sql<{
          receipt_json: string;
        }>`SELECT receipt_json FROM auto_model_admissions
        WHERE thread_id = ${threadId} AND task_id = ${input.task.id} ORDER BY revision DESC LIMIT 1`;
        const previous = rows[0] ? yield* decodeReceipt(rows[0].receipt_json) : undefined;
        const pin: AutoModelPin | undefined = previous?.pin;
        const measured = measureAutoModelDecision({ ...input, ...(pin ? { pin } : {}) }, () =>
          performance.now(),
        );
        if (measured.decision.status !== "selected")
          return yield* new AutoModelAdmissionError({
            reason: measured.decision.reason,
            exclusions: measured.decision.exclusions.flatMap((entry) =>
              entry.codes.map((code) => `${entry.ref.instanceId}/${entry.ref.modelId}: ${code}`),
            ),
          });
        if (!optionsValidated(input, measured.decision.pin.ref))
          return yield* new AutoModelAdmissionError({ reason: "selected-options-unvalidated" });
        const receipt = {
          type: "auto-model.admitted" as const,
          threadId,
          requestId,
          revision: (previous?.revision ?? 0) + 1,
          pin: measured.decision.pin,
          reason: measured.decision.reason,
          resolverDurationMs: measured.resolverDurationMs,
        };
        const receiptJson = yield* encodeReceipt(receipt);
        yield* sql`INSERT INTO auto_model_admissions
        (thread_id, task_id, revision, request_id, request_identity, receipt_json)
        VALUES (${threadId}, ${input.task.id}, ${receipt.revision}, ${requestId}, ${identity}, ${receiptJson})`;
        return receipt;
      }),
    );
  });
  return { admit };
});
