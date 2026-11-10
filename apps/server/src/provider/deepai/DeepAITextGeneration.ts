import { TextGenerationError } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildBranchNamePrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import { makeDeepAIClient, type DeepAIModel } from "./DeepAIClient.ts";

const ResponseBody = Schema.Struct({
  choices: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
    ),
  ),
  output: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        content: Schema.optionalKey(
          Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
        ),
      }),
    ),
  ),
});
const decodeResponse = Schema.decodeUnknownSync(ResponseBody);

export function makeDeepAITextGeneration(options: {
  credentials: () => Promise<string>;
  client?: ReturnType<typeof makeDeepAIClient>;
  catalog: () => Promise<{ models: ReadonlyArray<DeepAIModel> }>;
}): TextGeneration["Service"] {
  const client = options.client ?? makeDeepAIClient();
  const generate = <A>(modelId: string, prompt: string, schema: Schema.Codec<A, unknown>) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: async (signal) => {
          const apiKey = await options.credentials();
          const catalog = await options.catalog();
          const model = catalog.models.find((item) => item.id === modelId);
          if (!model) throw new Error("Unavailable model.");
          const response = await client.completion({
            apiKey,
            api: model.api ?? "openai-completions",
            signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
            body: {
              model: modelId,
              stream: false,
              ...(model.api === "openai-responses"
                ? { input: prompt, max_output_tokens: 4096 }
                : { messages: [{ role: "user", content: prompt }], max_tokens: 4096 }),
            },
          });
          const body = decodeResponse(await response.json());
          return (
            body.choices?.[0]?.message.content ??
            body.output
              ?.flatMap((item) => item.content?.map((part) => part.text ?? "") ?? [])
              .join("") ??
            ""
          );
        },
        catch: () =>
          new TextGenerationError({
            operation: "DeepAI generation",
            detail: "DeepAI could not generate this content. Check sign-in and model allowance.",
          }),
      });
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
        extractJsonObject(result),
      ).pipe(
        Effect.mapError(
          () =>
            new TextGenerationError({
              operation: "DeepAI generation",
              detail: "DeepAI returned invalid structured content.",
            }),
        ),
      );
    });
  return {
    generateCommitMessage: (input) => {
      const built = buildCommitMessagePrompt(input);
      return generate(input.modelSelection.model, built.prompt, built.outputSchema).pipe(
        Effect.map((value) => ({
          subject: sanitizeCommitSubject(value.subject),
          body: value.body.trim(),
          ...("branch" in value && typeof value.branch === "string"
            ? { branch: sanitizeFeatureBranchName(value.branch) }
            : {}),
        })),
      );
    },
    generatePrContent: (input) => {
      const built = buildPrContentPrompt(input);
      return generate(input.modelSelection.model, built.prompt, built.outputSchema).pipe(
        Effect.map((value) => ({ title: sanitizePrTitle(value.title), body: value.body.trim() })),
      );
    },
    generateBranchName: (input) => {
      const built = buildBranchNamePrompt(input);
      return generate(input.modelSelection.model, built.prompt, built.outputSchema).pipe(
        Effect.map((value) => ({ branch: sanitizeBranchFragment(value.branch) })),
      );
    },
    generateThreadTitle: (input) => {
      const built = buildThreadTitlePrompt(input);
      return generate(input.modelSelection.model, built.prompt, built.outputSchema).pipe(
        Effect.map((value) => ({ ...value, title: sanitizeThreadTitle(value.title) })),
      );
    },
  };
}
