/** A project coordinator is an explicit durable claim, not a title or recency guess. */
export const PROJECT_BUILD_OWNER_TASK = "project-build-integration";

export function isBuildIntegrationRequest(taskId: string, request = ""): boolean {
  const task = taskId.toLowerCase().replace(/[_:-]/g, " ");
  if (
    /\b(build|release|publish)\b.*\bintegrat\w*\b|\bintegrat\w*\b.*\b(build|release|publish)\b/.test(
      task,
    )
  )
    return true;
  return (
    /\b(next|latest|upcoming|current)\s+(j1\s+)?(build|release|update)\b/i.test(request) &&
    /\b(include|integrat\w*|handoff|hand\s*off|coordinat\w*|changes|completed)\b/i.test(request)
  );
}
