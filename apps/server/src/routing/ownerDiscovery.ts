export interface OwnerEndpoint {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
}

/** Snapshot supplied by J1, never inferred from a Hive client ID or a chat title. */
export interface CurrentOwnerShell extends OwnerEndpoint {
  readonly taskIds: readonly string[];
  readonly state: "available" | "archived" | "deleted" | "unavailable";
}

export interface TaskOwnerEvidence {
  readonly source: "builtin" | "hive";
  readonly recordId: string;
  readonly taskId: string;
  /** Explicit trusted mapping; opaque external owner IDs must not be decoded. */
  readonly endpoint: OwnerEndpoint | null;
  readonly observedAt: number;
  readonly validUntil: number;
  /** Hive ownership requires a current lease, independently of record freshness. */
  readonly lease: { readonly startsAt: number; readonly expiresAt: number } | null;
}

export interface OwnerDiscoveryInput {
  readonly taskId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly now: number;
  readonly shells: readonly CurrentOwnerShell[];
  readonly evidence: readonly TaskOwnerEvidence[];
  readonly hiveAvailable: boolean;
}

export interface OwnerAssessment {
  readonly evidence: TaskOwnerEvidence;
  readonly reason: string;
}

export interface OwnerSuggestion {
  readonly endpoint: OwnerEndpoint;
  readonly provenance: readonly TaskOwnerEvidence[];
}

export interface OwnerDiscoveryResult {
  readonly status: "selected" | "suggestions" | "none";
  readonly owner: OwnerEndpoint | null;
  readonly reason: string;
  readonly suggestions: readonly OwnerSuggestion[];
  readonly assessments: readonly OwnerAssessment[];
}

function key(endpoint: OwnerEndpoint) {
  return JSON.stringify([endpoint.environmentId, endpoint.projectId, endpoint.threadId]);
}

/** Pure discovery only. Callers must refresh facts and apply delivery admission separately. */
export function discoverTaskOwner(input: OwnerDiscoveryInput): OwnerDiscoveryResult {
  const groups = new Map<string, { endpoint: OwnerEndpoint; provenance: TaskOwnerEvidence[] }>();
  function rejection(evidence: TaskOwnerEvidence): string | null {
    if (
      !input.taskId.trim() ||
      !input.environmentId.trim() ||
      !input.projectId.trim() ||
      !Number.isFinite(input.now)
    )
      return "invalid-query";
    if (evidence.taskId !== input.taskId) return "task-id-mismatch";
    if (evidence.source === "hive" && !input.hiveAvailable) return "hive-unavailable";
    const endpoint = evidence.endpoint;
    if (!endpoint || !endpoint.threadId.trim()) return "owner-unmapped";
    if (endpoint.environmentId !== input.environmentId) return "environment-mismatch";
    if (endpoint.projectId !== input.projectId) return "project-mismatch";
    if (
      !evidence.recordId.trim() ||
      !Number.isFinite(evidence.observedAt) ||
      !Number.isFinite(evidence.validUntil) ||
      evidence.observedAt > input.now ||
      evidence.validUntil <= input.now
    )
      return "stale-evidence";
    const lease = evidence.lease;
    if (evidence.source === "hive" && !lease) return "lease-required";
    if (
      lease &&
      (!Number.isFinite(lease.startsAt) ||
        !Number.isFinite(lease.expiresAt) ||
        lease.startsAt > input.now ||
        lease.expiresAt <= input.now)
    )
      return "lease-invalid";
    const shells = input.shells.filter((shell) => key(shell) === key(endpoint));
    if (shells.length === 0) return "shell-missing";
    if (shells.length !== 1) return "shell-conflict";
    const shell = shells[0]!;
    if (shell.state !== "available") return `shell-${shell.state}`;
    if (!shell.taskIds.includes(input.taskId)) return "shell-task-unbound";
    return null;
  }
  // Stable output independent of backend enumeration order, including duplicate records.
  const evidence = [...input.evidence].sort((a, b) => {
    const left = JSON.stringify([
      a.source,
      a.recordId,
      a.taskId,
      a.endpoint && key(a.endpoint),
      a.observedAt,
      a.validUntil,
      a.lease,
    ]);
    const right = JSON.stringify([
      b.source,
      b.recordId,
      b.taskId,
      b.endpoint && key(b.endpoint),
      b.observedAt,
      b.validUntil,
      b.lease,
    ]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const assessments = evidence.map((item): OwnerAssessment => {
    const reason = rejection(item);
    if (!reason && item.endpoint) {
      const id = key(item.endpoint);
      const group = groups.get(id) ?? { endpoint: item.endpoint, provenance: [] };
      group.provenance.push(item);
      groups.set(id, group);
    }
    return { evidence: item, reason: reason ?? "exact-current-owner" };
  });
  const suggestions = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => group);
  return {
    status: suggestions.length === 1 ? "selected" : suggestions.length > 1 ? "suggestions" : "none",
    owner: suggestions.length === 1 ? suggestions[0]!.endpoint : null,
    reason:
      suggestions.length === 1
        ? "exact-current-owner"
        : suggestions.length > 1
          ? "multiple-current-owners"
          : "no-current-owner",
    suggestions,
    assessments,
  };
}
