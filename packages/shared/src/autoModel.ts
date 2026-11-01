import type { ProviderOptionSelections } from "@t3tools/contracts";

/** Conservative first-pass rules; uncertain requests retain the capable model. */
export function classifyAutoModelRequest(text: string) {
  const value = text.trim();
  if (
    /\b(implement|debug|investigate|research|refactor|migrat\w*|authenticat\w*|deploy|security|architecture)\b/i.test(
      value,
    )
  )
    return { complexity: "complex", highRisk: "unknown", crossComponent: "unknown" } as const;
  if (
    value.length <= 4000 &&
    /^(please\s+)?(rewrite|rephrase|proofread|summari[sz]e|translate|shorten|explain what|what is|what are|who is|define)\b/i.test(
      value,
    )
  )
    return { complexity: "simple", highRisk: false, crossComponent: false } as const;
  return { complexity: "unknown", highRisk: "unknown", crossComponent: "unknown" } as const;
}

/** Identity is exact: two installations exposing the same model are distinct choices. */
export interface AutoModelRef {
  readonly provider: string;
  readonly instanceId: string;
  readonly modelId: string;
  /** Provider settings, including reasoning effort, travel with the selected model. */
  readonly options?: ProviderOptionSelections;
}
export type AutoModelKnowledge = true | false | "unknown";
export interface AutoModelCandidate {
  readonly ref: AutoModelRef;
  readonly available: AutoModelKnowledge;
  readonly tools: AutoModelKnowledge;
  readonly images: AutoModelKnowledge;
  readonly contextWindow: number | "unknown";
}
export interface AutoModelConfig {
  readonly fast: AutoModelRef;
  readonly deep: AutoModelRef;
}
export interface AutoModelTask {
  readonly id: string;
  /** Signals must come from explicit caller evidence, not model-name heuristics. */
  readonly complexity: "simple" | "complex" | "unknown";
  readonly highRisk: AutoModelKnowledge;
  readonly crossComponent: AutoModelKnowledge;
  readonly requiresTools: boolean;
  readonly requiresImages: boolean;
  /** Total required input + output budget; null means the caller cannot establish it. */
  readonly requiredContextTokens: number | null;
}
export interface AutoModelPin {
  readonly taskId: string;
  readonly ref: AutoModelRef;
  readonly mode: "fast" | "deep" | "manual";
}
export interface AutoModelInput {
  readonly defaults: AutoModelConfig;
  /** Whole-pair override avoids accidentally mixing global and project instances. */
  readonly projectOverride?: AutoModelConfig;
  readonly manual?: AutoModelRef;
  readonly candidates: readonly AutoModelCandidate[];
  readonly task: AutoModelTask;
  readonly pin?: AutoModelPin;
  /** True only after in-flight generation/tools have drained and switching is safe. */
  readonly safeBoundary: boolean;
  readonly requestEscalation?: boolean;
}
export type AutoModelExclusionCode =
  | "missing"
  | "ambiguous"
  | "unavailable"
  | "availability-unknown"
  | "tools-unsupported"
  | "tools-unknown"
  | "images-unsupported"
  | "images-unknown"
  | "context-unknown"
  | "context-invalid"
  | "context-insufficient";
export interface AutoModelExclusion {
  readonly ref: AutoModelRef;
  readonly codes: readonly AutoModelExclusionCode[];
}
export type AutoModelRule = "high-risk" | "cross-component" | "complex" | "uncertain" | "simple";
export type AutoModelDecision =
  | {
      readonly status: "selected";
      readonly pin: AutoModelPin;
      readonly reason:
        | "manual"
        | "pinned"
        | "escalated"
        | "escalation-deferred"
        | "capability-escalation"
        | AutoModelRule;
      readonly exclusions: readonly AutoModelExclusion[];
    }
  | {
      readonly status: "blocked";
      readonly reason: "task-mismatch" | "unsafe-switch" | "ineligible";
      readonly exclusions: readonly AutoModelExclusion[];
    };

const sameRef = (a: AutoModelRef, b: AutoModelRef) =>
  a.provider === b.provider && a.instanceId === b.instanceId && a.modelId === b.modelId;
const sameSelection = (a: AutoModelRef, b: AutoModelRef) =>
  sameRef(a, b) &&
  JSON.stringify([...(a.options ?? [])].sort((left, right) => left.id.localeCompare(right.id))) ===
    JSON.stringify([...(b.options ?? [])].sort((left, right) => left.id.localeCompare(right.id)));

/** Ordered rules: risk and scope take precedence over a caller's simple-task signal. */
export function autoModelRule(task: AutoModelTask): AutoModelRule {
  if (task.highRisk === true) return "high-risk";
  if (task.crossComponent === true) return "cross-component";
  if (task.complexity === "complex") return "complex";
  if (
    task.highRisk === "unknown" ||
    task.crossComponent === "unknown" ||
    task.complexity === "unknown"
  )
    return "uncertain";
  return "simple";
}

/** Pure decision only. Callers persist the returned pin and revalidate metadata before dispatch. */
export function resolveAutoModel(input: AutoModelInput): AutoModelDecision {
  const exclusions: AutoModelExclusion[] = [];
  const eligible = (ref: AutoModelRef) => {
    const matches = input.candidates.filter((candidate) => sameRef(candidate.ref, ref));
    const candidate = matches[0];
    const codes: AutoModelExclusionCode[] = [];
    if (matches.length > 1) codes.push("ambiguous");
    else if (!candidate) codes.push("missing");
    else {
      if (candidate.available !== true)
        codes.push(candidate.available === false ? "unavailable" : "availability-unknown");
      if (input.task.requiresTools && candidate.tools !== true)
        codes.push(candidate.tools === false ? "tools-unsupported" : "tools-unknown");
      if (input.task.requiresImages && candidate.images !== true)
        codes.push(candidate.images === false ? "images-unsupported" : "images-unknown");
      const required = input.task.requiredContextTokens;
      const capacity = candidate.contextWindow;
      if (required === null || capacity === "unknown") codes.push("context-unknown");
      else if (
        !Number.isSafeInteger(required) ||
        required < 0 ||
        !Number.isSafeInteger(capacity) ||
        capacity <= 0
      )
        codes.push("context-invalid");
      else if (required > capacity) codes.push("context-insufficient");
    }
    if (codes.length) exclusions.push({ ref, codes });
    return codes.length === 0;
  };
  const blocked = (
    reason: Extract<AutoModelDecision, { status: "blocked" }>["reason"],
  ): AutoModelDecision => ({ status: "blocked", reason, exclusions });
  const selected = (
    pin: AutoModelPin,
    reason: Extract<AutoModelDecision, { status: "selected" }>["reason"],
  ): AutoModelDecision => ({ status: "selected", pin, reason, exclusions });
  const config = input.projectOverride ?? input.defaults;
  const rule = autoModelRule(input.task);
  const pin = input.pin;
  if (pin && pin.taskId !== input.task.id) return blocked("task-mismatch");
  if (input.manual) {
    if (pin && !sameSelection(pin.ref, input.manual) && !input.safeBoundary)
      return blocked("unsafe-switch");
    return eligible(input.manual)
      ? selected({ taskId: input.task.id, ref: input.manual, mode: "manual" }, "manual")
      : blocked("ineligible");
  }
  if (pin) {
    const pinEligible = eligible(pin.ref);
    const escalate =
      pin.mode === "fast" &&
      ((rule !== "simple" && rule !== "uncertain") ||
        input.requestEscalation === true ||
        !pinEligible);
    if (!escalate) return pinEligible ? selected(pin, "pinned") : blocked("ineligible");
    if (!input.safeBoundary)
      return pinEligible ? selected(pin, "escalation-deferred") : blocked("unsafe-switch");
    return eligible(config.deep)
      ? selected({ taskId: input.task.id, ref: config.deep, mode: "deep" }, "escalated")
      : blocked("ineligible");
  }
  if (rule === "simple" && !input.requestEscalation) {
    if (eligible(config.fast))
      return selected({ taskId: input.task.id, ref: config.fast, mode: "fast" }, rule);
    if (eligible(config.deep))
      return selected(
        { taskId: input.task.id, ref: config.deep, mode: "deep" },
        "capability-escalation",
      );
    return blocked("ineligible");
  }
  return eligible(config.deep)
    ? selected(
        { taskId: input.task.id, ref: config.deep, mode: "deep" },
        input.requestEscalation ? "escalated" : rule,
      )
    : blocked("ineligible");
}

/** Optional injected monotonic clock measures only synchronous resolver work, not provider latency. */
export function measureAutoModelDecision(input: AutoModelInput, now: () => number) {
  const start = now();
  const decision = resolveAutoModel(input);
  const elapsed = now() - start;
  return {
    decision,
    resolverDurationMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
  };
}
