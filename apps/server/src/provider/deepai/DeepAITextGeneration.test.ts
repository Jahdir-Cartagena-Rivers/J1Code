import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeDeepAITextGeneration } from "./DeepAITextGeneration.ts";

const fixture = vi.hoisted(() => ({
  reply: "",
  api: "openai-completions" as "openai-completions" | "openai-responses",
}));
vi.mock("./DeepAIClient.ts", () => ({
  makeDeepAIClient: () => ({
    completion: async () =>
      Response.json(
        fixture.api === "openai-completions"
          ? { choices: [{ message: { content: fixture.reply } }] }
          : { output: [{ content: [{ text: fixture.reply }] }] },
      ),
  }),
}));
const instanceId = ProviderInstanceId.make("deepai");
const generation = () =>
  makeDeepAITextGeneration({
    credentials: async () => "test",
    catalog: async () => ({
      models: [
        {
          id: "pilot",
          name: "Pilot",
          reasoning: false,
          input: ["text"],
          contextWindow: 4096,
          maxTokens: 1024,
          ...(fixture.api === "openai-responses" ? { api: "openai-responses" as const } : {}),
        },
      ],
    }),
  });

describe("DeepAI utility generation", () => {
  for (const api of ["openai-completions", "openai-responses"] as const) {
    it.effect(`decodes structured titles from ${api}`, () =>
      Effect.gen(function* () {
        fixture.api = api;
        fixture.reply = '```json\n{"title":"Fixture title"}\n```';
        const result = yield* generation().generateThreadTitle({
          cwd: "/fixture",
          message: "Title this",
          modelSelection: { instanceId, model: "pilot" },
        });
        expect(result.title).toBe("Fixture title");
      }),
    );
  }
  it.effect("rejects malformed content without exposing it", () =>
    Effect.gen(function* () {
      fixture.reply = '{"unrelated":"private text"}';
      const result = yield* generation()
        .generateThreadTitle({
          cwd: "/fixture",
          message: "Title",
          modelSelection: { instanceId, model: "pilot" },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.detail).toContain("invalid structured content");
    }),
  );
  it.effect("rejects unavailable models instead of silently selecting another", () =>
    Effect.gen(function* () {
      const result = yield* generation()
        .generateThreadTitle({
          cwd: "/fixture",
          message: "Title",
          modelSelection: { instanceId, model: "missing" },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
});
