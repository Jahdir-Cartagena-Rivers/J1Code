import { describe, expect, it } from "vite-plus/test";
import {
  discoverTaskOwner,
  type CurrentOwnerShell,
  type OwnerDiscoveryInput,
  type TaskOwnerEvidence,
} from "./ownerDiscovery.ts";

const endpoint = { environmentId: "env", projectId: "project", threadId: "owner" };
const shell: CurrentOwnerShell = { ...endpoint, taskIds: ["task"], state: "available" };
const evidence: TaskOwnerEvidence = {
  source: "hive",
  recordId: "record",
  taskId: "task",
  endpoint,
  observedAt: 10,
  validUntil: 100,
  lease: { startsAt: 10, expiresAt: 100 },
};
function resolve(overrides: Partial<OwnerDiscoveryInput> = {}) {
  return discoverTaskOwner({
    taskId: "task",
    environmentId: "env",
    projectId: "project",
    now: 50,
    shells: [shell],
    evidence: [evidence],
    hiveAvailable: true,
    ...overrides,
  });
}

describe("discoverTaskOwner", () => {
  it("selects an existing exact owner and preserves source provenance", () => {
    const result = resolve();
    expect(result.status).toBe("selected");
    expect(result.owner).toEqual(endpoint);
    expect(result.suggestions[0]?.provenance).toEqual([evidence]);
  });

  it("suggests two owners without selecting and is enumeration-order independent", () => {
    const other = { ...endpoint, threadId: "other" };
    const records = [evidence, { ...evidence, recordId: "other", endpoint: other }];
    const shells = [shell, { ...shell, ...other }];
    const result = resolve({ shells, evidence: records });
    expect(result.status).toBe("suggestions");
    expect(result.owner).toBeNull();
    expect(result.suggestions).toHaveLength(2);
    expect(resolve({ shells: shells.toReversed(), evidence: records.toReversed() })).toEqual(
      result,
    );
  });

  it("combines multiple sources for the same endpoint without false ambiguity", () => {
    const result = resolve({
      evidence: [evidence, { ...evidence, source: "builtin", lease: null }],
    });
    expect(result.status).toBe("selected");
    expect(result.suggestions[0]?.provenance).toHaveLength(2);
  });

  it.each([
    ["expired lease", { lease: { startsAt: 10, expiresAt: 50 } }, "lease-invalid"],
    ["future lease", { lease: { startsAt: 51, expiresAt: 100 } }, "lease-invalid"],
    ["missing lease", { lease: null }, "lease-required"],
    ["stale record", { validUntil: 50 }, "stale-evidence"],
    ["future record", { observedAt: 51 }, "stale-evidence"],
    ["invalid time", { validUntil: Number.NaN }, "stale-evidence"],
    ["opaque owner", { endpoint: null }, "owner-unmapped"],
    ["different task", { taskId: "task-other" }, "task-id-mismatch"],
    [
      "foreign environment",
      { endpoint: { ...endpoint, environmentId: "foreign" } },
      "environment-mismatch",
    ],
    ["foreign project", { endpoint: { ...endpoint, projectId: "foreign" } }, "project-mismatch"],
  ] satisfies readonly (readonly [string, Partial<TaskOwnerEvidence>, string])[])(
    "rejects %s",
    (_label, changes, reason) => {
      const result = resolve({ evidence: [{ ...evidence, ...changes }] });
      expect(result.owner).toBeNull();
      expect(result.assessments[0]?.reason).toBe(reason);
    },
  );

  it.each(["archived", "deleted", "unavailable"] as const)("rejects a %s J1 shell", (state) => {
    const result = resolve({ shells: [{ ...shell, state }] });
    expect(result.status).toBe("none");
    expect(result.assessments[0]?.reason).toBe(`shell-${state}`);
  });

  it("rejects missing, duplicate and unbound shells", () => {
    expect(resolve({ shells: [] }).assessments[0]?.reason).toBe("shell-missing");
    expect(resolve({ shells: [shell, shell] }).assessments[0]?.reason).toBe("shell-conflict");
    expect(
      resolve({ shells: [{ ...shell, taskIds: ["similar-task"] }] }).assessments[0]?.reason,
    ).toBe("shell-task-unbound");
  });

  it("supports built-in ownership without external Hive and ignores unavailable Hive evidence", () => {
    const builtin: TaskOwnerEvidence = { ...evidence, source: "builtin", lease: null };
    const result = resolve({ hiveAvailable: false, evidence: [evidence, builtin] });
    expect(result.owner).toEqual(endpoint);
    expect(result.suggestions[0]?.provenance).toEqual([builtin]);
    expect(result.assessments.map((item) => item.reason)).toContain("hive-unavailable");
    expect(resolve({ hiveAvailable: false, evidence: [] }).status).toBe("none");
  });

  it("never infers task ownership from a shell alone or generic similarity", () => {
    expect(resolve({ evidence: [] }).owner).toBeNull();
    expect(resolve({ taskId: "Task" }).owner).toBeNull();
    expect(resolve({ taskId: "" }).assessments[0]?.reason).toBe("invalid-query");
  });
});
