import { expect, it } from "vite-plus/test";
import { ProviderInstanceId, ServerProvider, type AutoModelPolicy } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { autoModelCandidates } from "./AutoModelCandidates.ts";
const instanceId = ProviderInstanceId.make("codex");
const policy = {
  mode: "auto",
  fast: { instanceId, model: "fast", options: [{ id: "effort", value: "low" }] },
  deep: { instanceId, model: "deep" },
  capabilities: { fast: { tools: true, contextWindow: 200000 } },
} satisfies AutoModelPolicy;
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId,
  driver: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00Z",
  models: [
    {
      slug: "fast",
      name: "Fast",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          { id: "effort", label: "Effort", type: "select", options: [{ id: "low", label: "Low" }] },
        ],
      },
    },
    { slug: "deep", name: "Deep", isCustom: false, capabilities: null },
  ],
});
it("uses trusted admin capabilities and validates exact live option values", () => {
  expect(autoModelCandidates(policy, [provider])[0]).toMatchObject({
    available: true,
    tools: true,
    images: "unknown",
    ref: { options: [{ id: "effort", value: "low" }] },
  });
  expect(
    autoModelCandidates(
      { ...policy, fast: { ...policy.fast, options: [{ id: "effort", value: "invented" }] } },
      [provider],
    )[0]?.available,
  ).toBe(false);
  expect(autoModelCandidates(policy, [provider])[1]).toMatchObject({
    available: true,
    tools: "unknown",
    contextWindow: "unknown",
  });
});
it("rejects missing, ambiguous, disabled and uninstalled exact instances", () => {
  for (const providers of [
    [],
    [provider, provider],
    [{ ...provider, enabled: false }],
    [{ ...provider, installed: false }],
    [{ ...provider, models: [] }],
  ])
    expect(autoModelCandidates(policy, providers)[0]?.available).toBe(false);
});

it("keeps conflicting tier options ambiguous instead of silently replacing deep options", () => {
  const candidates = autoModelCandidates(
    { ...policy, deep: { ...policy.fast, options: [{ id: "effort", value: "other" }] } },
    [provider],
  );
  expect(candidates).toHaveLength(2);
  expect(candidates[1]?.ref.options).toEqual([{ id: "effort", value: "other" }]);
});
