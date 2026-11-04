import { describe, expect, it } from "vite-plus/test";
import {
  autoModelRule,
  measureAutoModelDecision,
  resolveAutoModel,
  classifyAutoModelRequest,
} from "./autoModel.ts";

it("routes bounded rewrites cheaply and prioritizes implementation and uncertainty", () => {
  expect(
    autoModelRule({
      ...base.task,
      ...classifyAutoModelRequest("Rewrite this paragraph in plain English"),
    }),
  ).toBe("simple");
  expect(
    autoModelRule({
      ...base.task,
      ...classifyAutoModelRequest("Rewrite the authentication implementation"),
    }),
  ).not.toBe("simple");
  expect(
    autoModelRule({
      ...base.task,
      ...classifyAutoModelRequest("Continue the work from yesterday"),
    }),
  ).toBe("uncertain");
});
import type { AutoModelCandidate, AutoModelInput, AutoModelRef } from "./autoModel.ts";

it("continues the exact configured model without fresh native usage, while checking readiness and images", () => {
  const input = {
    ...base,
    continuation: fast,
    task: { ...base.task, requiredContextTokens: null },
  };
  expect(resolveAutoModel(input)).toMatchObject({
    status: "selected",
    reason: "context-continuation",
    pin: { ref: fast },
  });
  expect(
    resolveAutoModel({ ...input, candidates: [{ ...candidate(fast), available: false }] }),
  ).toMatchObject({ status: "blocked" });
  expect(
    resolveAutoModel({
      ...input,
      task: { ...input.task, requiresImages: true },
      candidates: [{ ...candidate(fast), images: "unknown" }],
    }),
  ).toMatchObject({ status: "blocked" });
  expect(
    resolveAutoModel({ ...input, pin: { taskId: "task", ref: deep, mode: "deep" } }),
  ).toMatchObject({ status: "blocked", reason: "unsafe-switch" });
});

const fast: AutoModelRef = { provider: "codex", instanceId: "local", modelId: "explicit-fast" };
const deep: AutoModelRef = { provider: "claude", instanceId: "remote", modelId: "explicit-deep" };
const candidate = (ref: AutoModelRef): AutoModelCandidate => ({
  ref,
  available: true,
  tools: true,
  images: true,
  contextWindow: 10000,
});
const base: AutoModelInput = {
  defaults: { fast, deep },
  candidates: [candidate(fast), candidate(deep)],
  task: {
    id: "task",
    complexity: "simple",
    highRisk: false,
    crossComponent: false,
    requiresTools: false,
    requiresImages: false,
    requiredContextTokens: 1000,
  },
  safeBoundary: true,
};
const pin = { taskId: "task", ref: fast, mode: "fast" as const };

describe("Auto model decision core", () => {
  it("carries configured reasoning options into the selected task pin", () => {
    const configuredDeep = { ...deep, options: [{ id: "reasoningEffort", value: "high" }] };
    expect(
      resolveAutoModel({
        ...base,
        defaults: { fast, deep: configuredDeep },
        task: { ...base.task, complexity: "complex" },
      }),
    ).toMatchObject({ status: "selected", pin: { ref: configuredDeep } });
    expect(
      resolveAutoModel({
        ...base,
        pin,
        manual: { ...fast, options: [{ id: "reasoningEffort", value: "high" }] },
        safeBoundary: false,
      }),
    ).toMatchObject({ status: "blocked", reason: "unsafe-switch" });
  });
  it("orders risk, scope, complexity and uncertainty before simple", () => {
    expect(autoModelRule(base.task)).toBe("simple");
    expect(autoModelRule({ ...base.task, complexity: "unknown" })).toBe("uncertain");
    expect(autoModelRule({ ...base.task, complexity: "complex", crossComponent: true })).toBe(
      "cross-component",
    );
    expect(autoModelRule({ ...base.task, highRisk: true, crossComponent: true })).toBe("high-risk");
    expect(
      resolveAutoModel({ ...base, task: { ...base.task, complexity: "complex" } }),
    ).toMatchObject({ status: "selected", pin: { ref: deep }, reason: "complex" });
  });
  it("uses the exact configured pair and explicit project override", () => {
    expect(resolveAutoModel(base)).toMatchObject({ status: "selected", pin: { ref: fast } });
    const project = { ...fast, instanceId: "project" };
    expect(
      resolveAutoModel({
        ...base,
        projectOverride: { fast: project, deep },
        candidates: [...base.candidates, candidate(project)],
      }),
    ).toMatchObject({ status: "selected", pin: { ref: project } });
    expect(
      resolveAutoModel({ ...base, candidates: [candidate({ ...fast, instanceId: "other" })] }),
    ).toMatchObject({ status: "blocked", reason: "ineligible" });
  });
  it("preserves manual selection without substituting an available model", () => {
    expect(resolveAutoModel({ ...base, manual: deep })).toMatchObject({
      status: "selected",
      reason: "manual",
      pin: { ref: deep, mode: "manual" },
    });
    expect(resolveAutoModel({ ...base, manual: { ...fast, modelId: "missing" } })).toMatchObject({
      status: "blocked",
      exclusions: [{ codes: ["missing"] }],
    });
  });
  it.each([
    [{ available: "unknown" }, "availability-unknown"],
    [{ available: false }, "unavailable"],
    [{ tools: "unknown" }, "tools-unknown"],
    [{ tools: false }, "tools-unsupported"],
    [{ images: "unknown" }, "images-unknown"],
    [{ images: false }, "images-unsupported"],
    [{ contextWindow: "unknown" }, "context-unknown"],
    [{ contextWindow: 999 }, "context-insufficient"],
    [{ contextWindow: NaN }, "context-invalid"],
  ] as const)("rejects unsupported or unknown required capabilities %j", (patch, code) => {
    const result = resolveAutoModel({
      ...base,
      manual: fast,
      task: { ...base.task, requiresTools: true, requiresImages: true },
      candidates: [{ ...candidate(fast), ...patch }],
    });
    expect(result).toMatchObject({ status: "blocked", exclusions: [{ codes: [code] }] });
  });
  it("does not require irrelevant tools/images and does not infer them from names", () => {
    expect(
      resolveAutoModel({
        ...base,
        candidates: [{ ...candidate(fast), tools: "unknown", images: false }],
      }),
    ).toMatchObject({ status: "selected", pin: { ref: fast } });
  });
  it("rejects unknown/invalid task budgets and duplicate identities", () => {
    for (const requiredContextTokens of [null, NaN, -1, Infinity]) {
      expect(
        resolveAutoModel({ ...base, task: { ...base.task, requiredContextTokens } }).status,
      ).toBe("blocked");
    }
    expect(
      resolveAutoModel({ ...base, manual: fast, candidates: [candidate(fast), candidate(fast)] }),
    ).toMatchObject({ status: "blocked", exclusions: [{ codes: ["ambiguous"] }] });
  });
  it("can escalate only to configured deep and explains excluded fast", () => {
    expect(
      resolveAutoModel({
        ...base,
        candidates: [{ ...candidate(fast), available: false }, candidate(deep)],
      }),
    ).toMatchObject({
      status: "selected",
      reason: "capability-escalation",
      pin: { ref: deep },
      exclusions: [{ ref: fast, codes: ["unavailable"] }],
    });
    expect(
      resolveAutoModel({
        ...base,
        task: { ...base.task, complexity: "complex" },
        candidates: [candidate(fast)],
      }).status,
    ).toBe("blocked");
  });
  it("retains task pin despite configuration changes and does not downgrade deep/manual", () => {
    expect(resolveAutoModel({ ...base, pin, defaults: { fast: deep, deep } })).toMatchObject({
      status: "selected",
      reason: "pinned",
      pin,
    });
    for (const mode of ["deep", "manual"] as const) {
      expect(resolveAutoModel({ ...base, pin: { ...pin, ref: deep, mode } })).toMatchObject({
        status: "selected",
        pin: { ref: deep, mode },
      });
    }
    expect(resolveAutoModel({ ...base, pin: { ...pin, taskId: "other" } })).toMatchObject({
      status: "blocked",
      reason: "task-mismatch",
    });
  });
  it("does not move a pinned task because a follow-up omitted task signals", () => {
    expect(
      resolveAutoModel({
        ...base,
        pin,
        task: {
          ...base.task,
          complexity: "unknown",
          highRisk: "unknown",
          crossComponent: "unknown",
        },
      }),
    ).toMatchObject({ status: "selected", reason: "pinned", pin });
  });
  it("defers escalation until safe and blocks unsafe manual switching", () => {
    expect(
      resolveAutoModel({ ...base, pin, requestEscalation: true, safeBoundary: false }),
    ).toMatchObject({ status: "selected", reason: "escalation-deferred", pin });
    expect(resolveAutoModel({ ...base, pin, requestEscalation: true })).toMatchObject({
      status: "selected",
      reason: "escalated",
      pin: { ref: deep },
    });
    expect(resolveAutoModel({ ...base, pin, manual: deep, safeBoundary: false })).toMatchObject({
      status: "blocked",
      reason: "unsafe-switch",
    });
    expect(
      resolveAutoModel({ ...base, pin, safeBoundary: false, candidates: [candidate(deep)] }),
    ).toMatchObject({ status: "blocked", reason: "unsafe-switch" });
  });
  it("measures pure resolution with an injected clock and rejects invalid timing", () => {
    let time = 10;
    expect(measureAutoModelDecision(base, () => time++)).toMatchObject({
      decision: { status: "selected" },
      resolverDurationMs: 1,
    });
    expect(measureAutoModelDecision(base, () => NaN).resolverDurationMs).toBeNull();
  });
});
