import { parseGoalCommand } from "@j1code/contracts";
import { splitsSurrogatePair } from "@j1code/shared/assistantCitations";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

type OutputSchema = Readonly<Record<string, Schema.Json>>;

// A schema built from JSON Schema needs no services, which its `Schema.Top` type cannot say.
const compile = (schema: OutputSchema) =>
  Result.try(
    () =>
      SchemaRepresentation.fromJsonSchemaDocument(
        JsonSchema.fromSchemaDraft2020_12(schema),
      ) as Schema.Codec<unknown>,
  );

const MAX_SCHEMA_CHARS = 32_000;

export const isProviderCommand = (message: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}): boolean =>
  (message.attachments?.length ?? 0) === 0 &&
  (["/compact", "/logout"].includes(message.text.trim().toLowerCase()) ||
    parseGoalCommand(message) !== null);

export const outputRequestProblem = (
  schema: OutputSchema,
  message: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> | undefined },
): string | null => {
  if (isProviderCommand(message))
    return "A command cannot be asked for a result. Ask for it in a message.";
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS)
    return `The output schema exceeds ${MAX_SCHEMA_CHARS} characters.`;
  return Result.isFailure(compile(schema)) ? "The output schema is invalid." : null;
};

export const outputInstructions = (schema: OutputSchema): string =>
  [
    "The caller reads the structured result of this turn.",
    "When the work is done, call `t3_submit_output` once with `json` set to JSON text matching this JSON Schema.",
    JSON.stringify(schema),
    "If you could not finish, still submit a result using the fields that report the outcome. Correct and resubmit a result the tool rejects.",
  ].join("\n");

/** Why a submission was turned down. What did not fit is in `cause`, never in the problem. */
export interface OutputRejection {
  readonly problem: string;
  readonly cause?: unknown;
}

/** The rejection as told to whoever wrote the value: the problem, then what in it did not fit. */
export const rejectionText = (rejection: OutputRejection): string => {
  if (!(rejection.cause instanceof Error)) return rejection.problem;
  const { message } = rejection.cause;
  return `${rejection.problem}\n${message.slice(0, splitsSurrogatePair(message, 2000) ? 1999 : 2000)}`;
};

/**
 * Checks what an agent submitted against the schema its run declared. The value is kept as
 * submitted. A schema that closes its object turns down keys it does not name; an open one keeps
 * them.
 */
export const checkOutput = Effect.fn("runOutput.checkOutput")(function* (
  schema: OutputSchema,
  json: string,
) {
  const parsed = Result.try(() => JSON.parse(json) as Schema.Json);
  if (Result.isFailure(parsed)) {
    return Result.fail<OutputRejection>({ problem: "`json` is not valid JSON text." });
  }
  const compiled = compile(schema);
  if (Result.isFailure(compiled)) {
    return Result.fail<OutputRejection>({
      problem: "The output schema is not a usable JSON Schema.",
    });
  }
  const outputSchema = compiled.success;
  const decoded = yield* Schema.decodeEffect(outputSchema)(parsed.success, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(Effect.result);
  return Result.isFailure(decoded)
    ? Result.fail<OutputRejection>({
        problem: "The result does not match the schema.",
        cause: decoded.failure,
      })
    : Result.succeed(parsed.success);
});
