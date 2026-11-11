import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Preserve full filesystem access while letting Codex request human review of flagged commands. */
export async function patchCodexPolicyReview(stage: string) {
  const replace = async (file: string, before: string, after: string, count = 1) => {
    const path = NodePath.join(stage, file);
    const source = (await NodeFSP.readFile(path, "utf8")).replaceAll("\r\n", "\n");
    if (source.split(before).length !== count + 1)
      throw new Error(`Pinned approval source changed: ${file}`);
    await NodeFSP.writeFile(path, source.replaceAll(before, after));
  };
  for (const sandbox of [
    'sandbox: "danger-full-access"',
    'sandboxPolicy: { type: "dangerFullAccess" }',
  ]) {
    await replace(
      "server/drivers/codex.ts",
      `approvalPolicy: "never",\n        approvalsReviewer: "user",\n        ${sandbox}`,
      `approvalPolicy: "on-request",\n        approvalsReviewer: "user",\n        ${sandbox}`,
    );
  }
  await replace(
    "server/drivers/codex.ts",
    "if (autoAcceptPermissions && isPermission && answersAlone(shell)) {",
    'if (autoAcceptPermissions && isPermission && answersAlone(shell) && method !== "execCommandApproval" && method !== "item/commandExecution/requestApproval") {',
  );
  await replace(
    "server/drivers/codex.ts",
    "requiresExplicitApproval: isAdditionalPermission || (",
    'requiresExplicitApproval: isAdditionalPermission || method === "execCommandApproval" || method === "item/commandExecution/requestApproval" || (',
  );
  await replace(
    "server/drivers/codex.test.ts",
    '["full", "never", "danger-full-access", "dangerFullAccess"]',
    '["full", "on-request", "danger-full-access", "dangerFullAccess"]',
    2,
  );
  const tests = await NodeFSP.readFile(
    new URL("./codex-policy-review.test.ts.txt", import.meta.url),
    "utf8",
  );
  await replace(
    "server/drivers/codex.test.ts",
    "  const startupMounts = {",
    tests + "  const startupMounts = {",
  );
  await replace(
    "server/testing/fake-codex-app-server.ts",
    'mode === "resume" || mode === "review-events"',
    'mode === "resume" || mode === "approval" || mode === "review-events"',
  );
}
