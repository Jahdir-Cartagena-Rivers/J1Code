import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { patchOpenMausImport } from "./patch-import.ts";
import { patchMobileShell } from "./patch-mobile-shell.ts";
import { patchLegacySettingsWindow, patchSettingsWindow } from "./patch-settings-window.ts";
import { patchSharedExecution } from "./patch-shared-execution.ts";

export const MAUSBOT_SOURCE = "d818c28aa80686dc1d7db64ebeffa2a9dc468762";
const MAUSBOT_V0182 = "140172d88382a97e1c3420d55f3df8ba472a9cfe";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");

/** Applies only to our disposable, pinned OSS assembly; never edits the reference checkout. */
export async function patchMausbotSource(stage: string, sourceRef = MAUSBOT_SOURCE) {
  const latestSource = sourceRef === MAUSBOT_V0182;
  await patchOpenMausImport(stage, { useNativeBackupVersion: latestSource });
  const bubblePath = NodePath.join(stage, "src/components/chat-bubble.ts");
  const bubbles = await NodeFSP.readFile(bubblePath, "utf8");
  if (!bubbles.includes("calc(100%-82px)")) throw new Error("Pinned bubble width changed.");
  await NodeFSP.writeFile(bubblePath, bubbles.replace("calc(100%-82px)", "calc(100%-var(--chat-bubble-gutter,82px))"));
  // v0.1.182 already contains both upstream fixes.
  const backports = latestSource
    ? []
    : ["e14bffd0-memory-queue.patch", "ba3c2b7c-retry-cleanup.patch"];
  for (const file of backports)
    await NodeUtil.promisify(NodeChildProcess.execFile)(
      "git",
      ["apply", NodePath.join(root, "scripts/mausbot/upstream", file)],
      { cwd: stage, windowsHide: true },
    );
  const change = async (file: string, before: string, after: string) => {
    const path = NodePath.join(stage, file);
    const source = (await NodeFSP.readFile(path, "utf8")).replaceAll("\r\n", "\n");
    if (source.split(before).length !== 2)
      throw new Error(`Pinned Mausbot source changed: ${file}`);
    await NodeFSP.writeFile(path, source.replace(before, after));
  };
  const copy = (from: string, to: string) =>
    NodeFSP.copyFile(NodePath.join(root, from), NodePath.join(stage, to));
  await change(
    "src/lib/composer-attachments.ts",
    `export function isImageFile(file: { type: string; size?: number }): boolean {
  return (
    file.type.startsWith("image/") &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type.split(";")[0]!.trim().toLowerCase())
  );
}`,
    `function attachmentImageMime(file: { type: string; name?: string }): string | null {
  const mime = file.type.split(";", 1)[0]!.trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) return mime;
  if (mime === "image/jpg" || mime === "image/pjpeg") return "image/jpeg";
  // Android file providers can return an empty or generic MIME for screenshots.
  if ((mime === "" || mime === "application/octet-stream") && /\\.jpe?g$/i.test(file.name ?? "")) {
    return "image/jpeg";
  }
  return null;
}

export function isImageFile(file: { type: string; name?: string; size?: number }): boolean {
  return attachmentImageMime(file) !== null;
}`,
  );
  await change(
    "src/lib/composer-attachments.ts",
    `  if (!isImageFile(file)) return null;
  if (file.size > IMAGE_MAX_BYTES) throw new AttachError(file.name, IMAGE_MAX_BYTES);
  const mime = file.type.split(";", 1)[0]!.trim().toLowerCase();`,
    `  const mime = attachmentImageMime(file);
  if (!mime) return null;
  if (file.size > IMAGE_MAX_BYTES) throw new AttachError(file.name, IMAGE_MAX_BYTES);`,
  );
  await change(
    "src/lib/composer-attachments.ts",
    `  if (!isImageFile(file)) return null;
  if (file.size > IMAGE_MAX_BYTES) throw new AttachError(file.name, IMAGE_MAX_BYTES);
  const bytes = new Uint8Array(await file.arrayBuffer());`,
    `  const mime = attachmentImageMime(file);
  if (!mime) return null;
  if (file.size > IMAGE_MAX_BYTES) throw new AttachError(file.name, IMAGE_MAX_BYTES);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (mime === "image/jpeg" && file.type.split(";", 1)[0]!.trim().toLowerCase() !== mime &&
      (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)) {
    throw new Error("The selected file is not a JPEG image.");
  }`,
  );
  await change(
    "src/lib/composer-attachments.ts",
    'headers: { "content-type": file.type },',
    'headers: { "content-type": mime },',
  );
  await copy("scripts/mausbot/android-jpeg.test.ts.txt", "src/lib/j1-android-jpeg.test.ts");
  await NodeFSP.mkdir(NodePath.join(stage, "server/j1"), { recursive: true });
  await copy(
    "apps/server/src/provider/AuthorizationInstructions.ts",
    "server/j1/authorization-instructions.ts",
  );
  await copy(
    "scripts/mausbot/authorization-guidance.test.ts.txt",
    "server/j1/authorization-guidance.test.ts",
  );
  await change(
    "server/reply-habits.ts",
    "export const REPLY_HABITS_PROMPT =",
    'import { AUTHORIZATION_INSTRUCTIONS } from "./j1/authorization-instructions.ts";\n\nconst BASE_REPLY_HABITS_PROMPT =',
  );
  await NodeFSP.appendFile(
    NodePath.join(stage, "server/reply-habits.ts"),
    '\nexport const REPLY_HABITS_PROMPT = BASE_REPLY_HABITS_PROMPT + "\\n\\n" + AUTHORIZATION_INSTRUCTIONS;\n',
  );
  await change(
    latestSource ? "packages/phone-protocol/src/outbound.ts" : "shared/outbound.ts",
    "  if (AGENTS_X_READS.test(name)) return false;",
    "  if (AGENTS_X_READS.test(name)) return false;\n  // J1 validates this return channel against the two original route participants.\n  if (/^(?:mcp__agents__|agents__|agents_)?reply_to_route$/.test(name)) return false;",
  );
  await copy("scripts/mausbot/routing-feedback.test.ts.txt", "server/j1/routing-feedback.test.ts");
  // Preserve upstream checksum/version gates without PowerShell's non-terminating extraction errors.
  if (!latestSource) {
    await change(
    "scripts/prepare-cua-win.mjs",
    `  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Expand-Archive -LiteralPath $env:OMB_CUA_ARCHIVE -DestinationPath $env:OMB_CUA_EXTRACT"], {
    env: { ...process.env, OMB_CUA_ARCHIVE: archive, OMB_CUA_EXTRACT: cache },
    timeout: 60_000,
    windowsHide: true,
  });`,
    `  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot) throw new Error("Windows system directory is unavailable for CUA extraction");
  await run(join(systemRoot, "System32", "tar.exe"), ["-xf", archive, "-C", cache], {
    timeout: 60_000,
    windowsHide: true,
  });`,
    );
  }
  await NodeFSP.mkdir(NodePath.join(stage, "server/j1"), { recursive: true });
  await change(
    "src/state/config-status.ts",
    "export interface ConfigStatus {",
    "export interface ConfigStatus {\n  j1Managed?: boolean;",
  );
  const configFrame = latestSource ? "src/lib/config-status-frame.ts" : "src/state/store.tsx";
  await change(configFrame, '"xai" | "mistral"', '"j1Managed" | "xai" | "mistral"');
  // Managed J1 sessions use Lightpanda. Upstream Chrome switches and profiles
  // cannot affect that backend; keep their saved values for standalone imports.
  await change(
    "src/components/BrowserSettingsRows.tsx",
    "  if (on === undefined || owner !== true || !builtInBrowserEnabled(state.config)) return null;",
    "  if (state.config?.j1Managed || on === undefined || owner !== true || !builtInBrowserEnabled(state.config)) return null;",
  );
  await change(
    "src/components/BrowserSettingsRows.tsx",
    '  const on = state.config?.browserEngine?.engine === "chrome";\n  const { saving, error, save } = useConfigSave();',
    '  const on = state.config?.browserEngine?.engine === "chrome";\n  const { saving, error, save } = useConfigSave();\n  if (state.config?.j1Managed) return null;',
  );
  await change(
    "src/components/AppSettingsRows.tsx",
    "  if (!builtInBrowserEnabled(state.config) && profiles.length === 0) return null;",
    "  if (state.config?.j1Managed || (!builtInBrowserEnabled(state.config) && profiles.length === 0)) return null;",
  );
  await change(
    "src/components/BrowserSettingsRows.tsx",
    "  const { saving, error, save } = useConfigSave();\n\n  return (\n    <SettingRow",
    "  const { saving, error, save } = useConfigSave();\n  if (state.config?.j1Managed) return null;\n\n  return (\n    <SettingRow",
  );
  await change(
    configFrame,
    "    ...(frame.cloudHome ? { cloudHome: true } : {}),",
    "    j1Managed: frame.j1Managed, ...(frame.cloudHome ? { cloudHome: true } : {}),",
  );
  await change(
    "src/lib/place.ts",
    "config: { cloudHome?: boolean } | null | undefined): boolean {",
    'config: { cloudHome?: boolean; j1Managed?: boolean } | null | undefined): boolean {\n  if (config?.j1Managed && place === "vm") return false;',
  );
  await copy("scripts/mausbot/place.test.ts.txt", "src/lib/j1-place.test.ts");
  await change(
    "src/components/LocalComputerSection.test.ts",
    'toContain("not managed by MausBot")',
    'toContain("not managed by J1 Code")',
  );
  await change(
    "src/components/LocalComputerSection.test.ts",
    'toContain("No MausBot desktops found on your VPS")',
    'toContain("No J1 Code desktops found on your VPS")',
  );
  await change(
    "src/components/LocalComputerSection.tsx",
    "  const cloudHome = useStore().state.config?.cloudHome === true;",
    "  const config = useStore().state.config;\n  const omitContainerDesktop = config?.cloudHome === true || config?.j1Managed === true;",
  );
  await change(
    "src/components/LocalComputerSection.tsx",
    "    if (cloudHome) return;",
    "    if (omitContainerDesktop) return;",
  );
  await change(
    "src/components/LocalComputerSection.tsx",
    "  }, [cloudHome, refresh, refreshKey]);",
    "  }, [omitContainerDesktop, refresh, refreshKey]);",
  );
  await change(
    "src/components/LocalComputerSection.tsx",
    "      {!cloudHome && <>",
    "      {!omitContainerDesktop && <>",
  );
  await copy("scripts/mausbot/hive-memory.ts", "server/j1/hive-memory.ts");
  await copy("scripts/mausbot/agents-hive-memory.ts", "server/j1/agents-hive-memory.ts");
  await copy(
    "scripts/mausbot/agents-hive-memory.test.ts.txt",
    "server/j1/agents-hive-memory.test.ts",
  );
  await copy("scripts/mausbot/conversations.ts", "server/j1/conversations.ts");
  await copy("scripts/mausbot/route-receiver.ts", "server/j1/route-receiver.ts");
  await copy("scripts/mausbot/route-receiver.test.ts.txt", "server/j1/route-receiver.test.ts");
  await copy("scripts/mausbot/agents-routing.test.ts.txt", "server/j1/agents-routing.test.ts");
  await copy("scripts/mausbot/TranscriptApproval.tsx", "src/components/TranscriptApproval.tsx");
  await copy("scripts/mausbot/J1RouteCard.tsx", "src/components/J1RouteCard.tsx");
  await copy("scripts/mausbot/route-card.test.ts.txt", "src/components/j1-route-card.test.ts");
  const messagePick = 'export interface Message extends Pick<import("../../shared/wire").WireMessage, ';
  await change(
    "src/state/store.tsx",
    messagePick,
    `${messagePick}"j1RouteId" | "j1RouteRevision" | `,
  );
  await change("src/components/AskCard.tsx", "ELEVATED_CARD, ELEVATED_FLOAT", "ELEVATED_CARD");
  await change("src/components/AskCard.tsx", "  stays = false,\n", "");
  await change(
    "src/components/AskCard.tsx",
    "/** Work rests on this card and the person's answer alone moves it: it stays in view however far the chat scrolls. */",
    "/** Kept for source compatibility; J1 requests scroll with their transcript. */",
  );
  await change(
    "src/components/AskCard.tsx",
    latestSource
      ? "stays ? `sticky top-[var(--glass-top,60px)] bottom-[72px] z-10 ${ELEVATED_FLOAT}` : ELEVATED_CARD"
      : "stays ? `sticky top-[60px] bottom-[72px] z-10 ${ELEVATED_FLOAT}` : ELEVATED_CARD",
    "ELEVATED_CARD",
  );
  await change(
    "src/components/Composer.tsx",
    'import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";',
    'import { pendingApprovals } from "./PendingApproval";',
  );
  await change(
    "src/components/Composer.tsx",
    latestSource ? "ELEVATED_CARD, ELEVATED_COMPOSER, ELEVATED_FLOAT" : "ELEVATED_CARD, ELEVATED_FLOAT",
    latestSource ? "ELEVATED_COMPOSER, ELEVATED_FLOAT" : "ELEVATED_FLOAT",
  );
  await change(
    "src/components/Composer.tsx",
    latestSource
      ? "  const asker = useStoreSelector((s) => s.bots.find((one) => one.id === approval?.message.inbox?.from.botId)), approvalBot = group\n    ? members?.find((member) => member.id === approval?.message.from?.botId) ??\n      members?.find((member) => member.id === groupBusyBotId)\n    : asker ?? bot;\n"
      : "  const approvalBot = group\n    ? members?.find((member) => member.id === approval?.message.from?.botId) ??\n      members?.find((member) => member.id === groupBusyBotId)\n    : state.bots.find((one) => one.id === approval?.message.inbox?.from.botId) ?? bot;\n",
    "",
  );
  await change(
    "src/components/Composer.tsx",
    `        {approval && (
          <div className={cn("mb-2 overflow-hidden rounded-[${latestSource ? 18 : 24}px]", ELEVATED_CARD)}>
            <PendingApprovalPanel
              key={approval.requestId}
              pending={approval}
              botName={approvalBot?.name} asker={approvalBot}
              count={approvals.length}
              index={0}
              locale={activeLocale()}
              actions={<PendingApprovalActions part="primary" pending={approval} threadId={threadId} bot={approvalBot} onCancelTurn={interruptTurn} />}
              more={approval.message.inbox ? undefined : <PendingApprovalActions part="more" pending={approval} threadId={threadId} bot={approvalBot} onCancelTurn={interruptTurn} />}
            />
          </div>
        )}
`,
    "",
  );
  await change(
    "src/components/OptionsCardRow.tsx",
    'import { ApprovalCard } from "./ApprovalCard";',
    'import { ApprovalCard } from "./ApprovalCard";\nimport { TranscriptApproval } from "./TranscriptApproval";\nimport { pendingApprovals } from "./PendingApproval";',
  );
  await change(
    "src/components/OptionsCardRow.tsx",
    "<ApprovalCard bot={{ name: botName }} message={m} threadId={threadId} />",
    "pendingApprovals([m]).length ? <TranscriptApproval message={m} botId={botId} threadId={threadId} /> : <ApprovalCard bot={{ name: botName }} message={m} threadId={threadId} />",
  );
  await change(
    "src/components/OptionsCardRow.tsx",
    "import { HelperIntro }",
    'import { J1RouteCard } from "./J1RouteCard";\nimport { HelperIntro }',
  );
  await change(
    "src/components/OptionsCardRow.tsx",
    "  if (m.helperFollowup) return null;",
    "  if (m.j1RouteId) return <J1RouteCard botId={botId} threadId={threadId} requestId={m.j1RouteId} revision={m.j1RouteRevision} text={m.text} />;\n  if (m.helperFollowup) return null;",
  );
  await change(
    "src/components/GroupView.tsx",
    'import { ApprovalCard } from "./ApprovalCard";',
    'import { ApprovalCard } from "./ApprovalCard";\nimport { TranscriptApproval } from "./TranscriptApproval";',
  );
  await change(
    "src/components/GroupView.tsx",
    "<ApprovalCard bot={memberOf(m.from?.botId)} message={m} threadId={group.threadId} />",
    '{pendingApprovals([m]).length ? <TranscriptApproval message={m} botId={m.from?.botId ?? group.busyBotId ?? ""} threadId={group.threadId} groupId={group.id} /> : <ApprovalCard bot={memberOf(m.from?.botId)} message={m} threadId={group.threadId} />}',
  );
  const wireMessage = latestSource
    ? "export interface WireMessage extends ServerTextLine, HelperIntroField, SetupCardFields, WaitLineField, CheckBackLineField, HandoffStatusField, BugReportField {"
    : "export interface WireMessage extends ServerTextLine, HelperIntroField, SetupCardFields, WaitLineField, BugReportField {";
  await change(
    latestSource ? "packages/phone-protocol/src/wire.ts" : "shared/wire.ts",
    wireMessage,
    `${wireMessage}\n  j1RouteId?: string;\n  j1RouteRevision?: number;\n  j1IncomingRoute?: { requestId: string; fingerprint: string; attemptId: string; state: 'sending' | 'rejected' | 'admitted' | 'applied' | 'uncertain'; generation?: string; providerTurnId?: string; environmentId?: string };`,
  );
  await copy("scripts/mausbot/conversations.test.ts.txt", "server/j1/conversations.test.ts");
  await copy("scripts/mausbot/agents-conversations.ts", "server/j1/agents-conversations.ts");
  await copy("scripts/mausbot/agents-routing.ts", "server/j1/agents-routing.ts");
  await change(
    "server/index.ts",
    "    onDispatchError?: (message: string) => void;\n    compactOnly?: boolean;",
    "    onDispatchError?: (message: string) => void;\n    onTransport?: (generation: string, providerTurnId: string) => void;\n    compactOnly?: boolean;",
  );
  await change(
    "server/contracts.ts",
    "  startupRecovery?: boolean;",
    "  startupRecovery?: boolean;\n  /** Positive transport proof; returning a logical turn id alone is admission. */\n  onInputSent?: (turnId: string) => void;",
  );
  await change(
    "server/drivers/codex.ts",
    "        // Only after turn/start accepted the input may the receipt claim delivery.",
    "        turn.onInputSent?.(turnId);\n        // Only after turn/start accepted the input may the receipt claim delivery.",
  );
  await change(
    "server/drivers/claude.ts",
    '        if (!(await writeUser(live, threadId, message)) && !running?.stopRequested) closeSession(threadId, "stdin write failed");',
    '        if (await writeUser(live, threadId, message)) turn.onInputSent?.(turnId);\n        else if (!running?.stopRequested) closeSession(threadId, "stdin write failed");',
  );
  await change(
    "server/drivers/claude.ts",
    '        closeSession(threadId, "stdin write failed");\n      }\n\n      return { turnId };',
    '        closeSession(threadId, "stdin write failed");\n      } else turn.onInputSent?.(turnId);\n\n      return { turnId };',
  );
  await change(
    "server/index.ts",
    "const directTurnGenerationByThread = new Map<string, string>();",
    `const directTurnGenerationByThread = new Map<string, string>();
const j1InputReady = new Map<string, { generation: string; turnId: string }>();
const j1InputHooks = new Map<string, { delivered: (generation: string, turnId: string) => void; failed: () => void }>();
function j1InputSent(threadId: string, generation: string, turnId: string) {
  if (directTurnGenerationByThread.get(threadId) !== generation) return;
  j1InputReady.set(threadId, { generation, turnId });
  const hook = j1InputHooks.get(generation); j1InputHooks.delete(generation);
  try { hook?.delivered(generation, turnId); } catch { console.error("Could not persist native routing transport proof."); }
  void requestHostConversation({ kind: "routingWake" }).catch(() => {});
}`,
  );
  await change(
    "server/index.ts",
    "  const resourceOwner: TurnOwner = { threadId, generation: dispatchClaimId };",
    '  if (opts?.onTransport) j1InputHooks.set(dispatchClaimId, { delivered: opts.onTransport, failed: () => opts?.onDispatchError?.("The provider did not receive the routed request.") });\n  const resourceOwner: TurnOwner = { threadId, generation: dispatchClaimId };',
  );
  await change(
    "server/index.ts",
    "  directTurnGenerationByThread.set(threadId, dispatchClaimId);",
    "  const j1PreviousGeneration = directTurnGenerationByThread.get(threadId);\n  if (j1PreviousGeneration) j1InputHooks.delete(j1PreviousGeneration);\n  j1InputReady.delete(threadId);\n  directTurnGenerationByThread.set(threadId, dispatchClaimId);",
  );
  await change(
    "server/index.ts",
    "      opts?.onDispatchError?.(message);\n      // A dispatch failure emits no turn.completed",
    "      opts?.onDispatchError?.(message);\n      j1InputHooks.delete(dispatchClaimId);\n      // A dispatch failure emits no turn.completed",
  );
  await change(
    "server/index.ts",
    "        startupRecovery,\n        text: withTurnClock",
    "        startupRecovery,\n        onInputSent: turnId => j1InputSent(threadId, dispatchClaimId, turnId),\n        text: withTurnClock",
  );
  await change(
    "server/index.ts",
    "  switch (event.type) {",
    `  if (requestOwner && event.turnId && (
    (event.type === "content.delta" && event.streamKind === "assistant_text" && event.delta) ||
    (event.type === "item.completed" && event.itemType === "assistant_text") ||
    (event.type === "turn.completed" && event.ok)
  ) && j1InputReady.get(event.threadId)?.generation !== requestOwner.generation)
    j1InputSent(event.threadId, requestOwner.generation, event.turnId);
  if (event.type === "turn.completed" && requestOwner) {
    const hook = j1InputHooks.get(requestOwner.generation); j1InputHooks.delete(requestOwner.generation);
    if (!event.ok) hook?.failed();
    j1InputReady.delete(event.threadId);
  }
  switch (event.type) {`,
  );
  await change(
    "server/drivers/codex.test.ts",
    '  it("reports an explicitly refused steer as refused so the caller queues, and keeps the child alive",',
    `  it("reports input transport only after the actual native start acknowledgement", async () => {
    await create({ mode: "approval" });
    let received!: (turnId: string) => void;
    const proof = new Promise<string>(resolve => { received = resolve; });
    const sent = await instance.adapter.sendTurn({ threadId: "j1-native-receipt", text: "one", onInputSent: received });
    expect(await proof).toBe(sent.turnId);
    await expect(instance.adapter.steer?.("j1-native-receipt", "same-turn update")).resolves.toBe("steered");
    await instance.adapter.interruptTurn("j1-native-receipt");
    await recorder.until(event => event.type === "turn.completed");
  }, 20_000);
  it("does not report transport for a refused native thread start", async () => {
    process.env.FAKE_CODEX_START_ERROR = JSON.stringify({ code: -32000, message: "not allowed" });
    await create({ mode: "approval" });
    const receipt = vi.fn();
    await instance.adapter.sendTurn({ threadId: "j1-native-rejected-receipt", text: "one", onInputSent: receipt });
    await recorder.until(event => event.type === "turn.completed");
    expect(receipt).not.toHaveBeenCalled();
  }, 20_000);
  it("reports an explicitly refused steer as refused so the caller queues, and keeps the child alive",`,
  );
  await copy(
    "scripts/mausbot/agents-conversations.test.ts.txt",
    "server/j1/agents-conversations.test.ts",
  );
  await change(
    "server/agent-tool-policy.ts",
    '  "list_threads",',
    '  "list_threads",\n  "hive_mind_recall",\n  "search_conversations",\n  "read_conversation",\n  "read_conversation_message",\n  "routing_mode",\n  "routing_status",\n  "list_routes",',
  );
  await change(
    "server/agent-tool-policy.test.ts",
    '      "list_threads",',
    '      "list_threads",\n      "hive_mind_recall",\n      "search_conversations",\n      "read_conversation",\n      "read_conversation_message",\n      "routing_mode",\n      "routing_status",\n      "list_routes",',
  );
  await change(
    "server/drivers/agents-catalog.ts",
    "const TOOL_DEFINITIONS = [",
    "const TOOL_DEFINITIONS = [\n  ...J1_HIVE_TOOLS,\n  ...J1_CONVERSATION_TOOLS,\n  ...J1_ROUTING_TOOLS,",
  );
  await change(
    "server/drivers/agents-catalog.ts",
    'import { MAUSBOT_TOOL_DEFINITIONS } from "./agents-mausbot-tools.ts";',
    'import { MAUSBOT_TOOL_DEFINITIONS } from "./agents-mausbot-tools.ts";\nimport { J1_CONVERSATION_TOOLS } from "../j1/agents-conversations.ts";\nimport { J1_HIVE_TOOLS, J1_HIVE_TOOL_NAMES } from "../j1/agents-hive-memory.ts";\nimport { J1_ROUTING_TOOLS } from "../j1/agents-routing.ts";',
  );
  await change(
    "server/drivers/agents-call.ts",
    'import { callMausBotTool, MAUSBOT_TOOL_NAMES } from "./agents-mausbot-tools.ts";',
    'import { callMausBotTool, MAUSBOT_TOOL_NAMES } from "./agents-mausbot-tools.ts";\nimport { callJ1Conversation, J1_CONVERSATION_TOOL_NAMES } from "../j1/agents-conversations.ts";\nimport { callJ1Hive, J1_HIVE_TOOL_NAMES } from "../j1/agents-hive-memory.ts";\nimport { callJ1Routing, J1_ROUTING_TOOL_NAMES } from "../j1/agents-routing.ts";',
  );
  await change(
    "server/drivers/agents-call.ts",
    '  if (name === "vm_exec") {',
    '  if (J1_HIVE_TOOL_NAMES.has(name)) return callJ1Hive(name, args, context);\n  if (J1_CONVERSATION_TOOL_NAMES.has(name)) return callJ1Conversation(name, args, context);\n  if (J1_ROUTING_TOOL_NAMES.has(name)) return callJ1Routing(name, args, context);\n  if (name === "vm_exec") {',
  );
  await change(
    "server/drivers/agents-catalog.ts",
    '(tool.name !== "memory_update" && tool.name !== "memory_log")',
    '(tool.name !== "memory_update" && tool.name !== "memory_log" && !J1_HIVE_TOOL_NAMES.has(tool.name))',
  );
  const hiveGuide = (mounted: string) =>
    `(${mounted} ? hiveProviderPrompt(toolScopeForTurn(bot.id), bot.memoryEnabled !== false) : "") + `;
  const memoryRules = latestSource ? "memoryRulesPrompt" : "memorySystemPrompt";
  const directMemory = `${memoryRules}(bot.id, { managedWrites: agentsMounted,`;
  await change("server/index.ts", `text: ${directMemory}`, `text: ${hiveGuide("agentsMounted")}${directMemory}`);
  const threadMemory = latestSource
    ? "memoryRulesPrompt(teamHost.layer(bot.id, threadId), memoryOpts)"
    : "memorySystemPrompt(teamHost.layer(bot.id, threadId),";
  await change("server/index.ts", `text: ${threadMemory}`, `text: ${hiveGuide("integrations.agents")}${threadMemory}`);
  if (latestSource) {
    const roomRules = "memoryRulesPrompt(teamHost.layer(bot.id, threadId), roomMemoryOpts)";
    await change("server/index.ts", `text: ${roomRules}`, `text: ${hiveGuide("integrations.agents")}${roomRules}`);
  } else {
    await change("server/index.ts", "const roomMemory = memorySystemPrompt(",
      `const roomMemory = ${hiveGuide("integrations.agents")}memorySystemPrompt(`);
  }
  const codexMountTest = await NodeFSP.readFile(
    NodePath.join(root, "scripts/mausbot/codex-hive-mount.test.ts.txt"),
    "utf8",
  );
  await change(
    "server/drivers/codex.test.ts",
    "  const startupMounts = {",
    codexMountTest + "  const startupMounts = {",
  );
  // Lift the original list policy verbatim so native tools and private history reads cannot drift.
  const threadRoutes = (
    await NodeFSP.readFile(NodePath.join(stage, "server/routes/internal-threads.ts"), "utf8")
  ).replaceAll("\r\n", "\n");
  const rowsStart = threadRoutes.indexOf("      const rows: ThreadRow[] = [];");
  const rowsEnd = threadRoutes.indexOf(
    latestSource
      ? '      const asked = Number(url.searchParams.get("page"));'
      : "      return json(res, 200, { threads: rows.slice(0, 100) });",
    rowsStart,
  );
  if (rowsStart < 0 || rowsEnd < 0)
    throw new Error("Pinned Mausbot thread visibility policy changed.");
  const rowsBody = threadRoutes.slice(rowsStart, rowsEnd);
  await change(
    "server/routes/internal-threads.ts",
    rowsBody,
    "      const rows = internalThreadRows(deps);\n",
  );
  await change(
    "server/routes/internal-threads.ts",
    "type ThreadState =",
    `export function internalThreadRows(deps: Parameters<typeof createInternalThreadRoutes>[0]): ThreadRow[] {\n  const { store, coordinator, from } = deps;\n${rowsBody}\n  return rows;\n}\n\ntype ThreadState =`,
  );
  await change(
    "server/index.ts",
    'import { createInternalThreadRoutes } from "./routes/internal-threads.ts";',
    'import { createInternalThreadRoutes, internalThreadRows } from "./routes/internal-threads.ts";\nimport { createConversationQueries, installConversationQueries, requestHostConversation, historyToolAllowed, type HistoryPrincipal } from "./j1/conversations.ts";\nimport { routingToolAllowed } from "./j1/agents-routing.ts";\nimport { hiveToolAllowed, parseHiveTool, hiveProviderPrompt } from "./j1/agents-hive-memory.ts";\nimport { createNativeRouteReceiver, unrestrictedRouteProfile, canForwardProjectRoute } from "./j1/route-receiver.ts";',
  );
  await change(
    "server/index.ts",
    "      const botFolders = async () =>",
    `      if (method === "POST" && path === "/api/internal/j1-hive-memory") {
        if (proactive.fence.confines(internalCapability.threadId) || botApiThread(internalCapability.threadId) || cloudLendingView(internalCapability) || CLOUD_TEAM || CLOUD_HOME) return json(res, 403, { error: "Shared J1 memory is unavailable in this conversation." });
        if (cloudGuestDriven(internalCapability.threadId)) return json(res, 403, { error: "Shared Hive Mind is unavailable to an outside-driven conversation." });
        const room = store.groupByThread(internalCapability.threadId);
        if (room && !roomFeedsBot(room, internalSender)) return json(res, 403, { error: "Shared memory cannot cross this room's audience boundary." });
        const body = z.object({ name: z.string(), arguments: z.unknown() }).strict().parse(await readInternalBody());
        const allowed = () => hiveToolAllowed(toolScopeForTurn(internalSender.id), body.name, store.bot(internalSender.id)?.memoryEnabled !== false);
        requireActiveInternalCapability();
        if (!allowed()) return json(res, 403, { error: "This Hive Mind tool is not allowed for this bot." });
        const input = parseHiveTool(body.name, body.arguments);
        const result = await J1Memory.providerCall({ ...input, botId: internalSender.id, threadId: internalCapability.threadId });
        requireActiveInternalCapability();
        if (!allowed()) return json(res, 403, { error: "This Hive Mind tool is no longer allowed for this bot." });
        return json(res, 200, result);
      }
      if (method === "POST" && path === "/api/internal/j1-routing") {
        if (proactive.fence.confines(internalCapability.threadId) || botApiThread(internalCapability.threadId) || cloudLendingView(internalCapability) || CLOUD_TEAM || CLOUD_HOME) return json(res, 403, { error: "Shared J1 routing is unavailable in this conversation." });
        const body = z.object({ operation: z.string(), arguments: z.unknown() }).strict().parse(await readInternalBody());
        requireActiveInternalCapability();
        if (cloudGuestDriven(internalCapability.threadId)) return json(res, 403, { error: "Shared routing is unavailable to an outside-driven conversation." });
        const routingRoom = store.groupByThread(internalCapability.threadId);
        if (routingRoom && !roomFeedsBot(routingRoom, internalSender)) return json(res, 403, { error: "Shared routing cannot cross this room's audience boundary." });
        if (body.operation === "route_task" && !canForwardProjectRoute(internalSender, internalCapability.depth, MAX_COMMS_DEPTH)) return json(res, 403, { error: "This delegated turn's permission profile cannot forward project work." });
        if (!routingToolAllowed(toolScopeForTurn(internalSender.id), body.operation)) return json(res, 403, { error: "This routing tool is not allowed for this bot." });
        const result = await requestHostConversation({ kind: "routing", botId: internalSender.id, threadId: internalCapability.threadId, generation: internalCapability.generation, ...body });
        requireActiveInternalCapability();
        if (!routingToolAllowed(toolScopeForTurn(internalSender.id), body.operation)) return json(res, 403, { error: "This routing tool is no longer allowed for this bot." });
        return json(res, 200, result);
      }
      if (method === "POST" && path === "/api/internal/j1-conversations") {
        if (proactive.fence.confines(internalCapability.threadId) || botApiThread(internalCapability.threadId) || cloudLendingView(internalCapability) || CLOUD_TEAM || CLOUD_HOME) return json(res, 403, { error: "Shared J1 history is unavailable in this conversation." });
        const call = await readInternalBody();
        requireActiveInternalCapability();
        if (!historyToolAllowed(toolScopeForTurn(internalSender.id), call)) return json(res, 403, { error: "This shared conversation tool is not allowed for this bot." });
        const result = await requestHostConversation({ botId: internalSender.id, threadId: internalCapability.threadId, generation: internalCapability.generation, call });
        requireActiveInternalCapability();
        if (!historyToolAllowed(toolScopeForTurn(internalSender.id), call)) return json(res, 403, { error: "This shared conversation tool is no longer allowed for this bot." });
        return json(res, 200, result);
      }
      const botFolders = async () =>`,
  );
  const threadDeps = `{
        store, coordinator, from: internalSender, fromThreadId: internalCapability.threadId,
        ownsThread: (botId, threadId) => Boolean(connectorThread(botId, threadId)),${latestSource ? " mainThreadTasks," : ""}
        shown: (id) => !proactive.fence.confines(id) && !botApiThread(id) && (CLOUD_TEAM ? teamHost.readableFrom(internalCapability.threadId)(id) : cloudLendingView(internalCapability) ? cloudOwnerOnlyThread(id) : true),
        threadBusy, queuedThreadPosition, queuedReason: queuedStatus,${latestSource ? " readBody: readInternalBody," : ""}
      }`;
  await change(
    "server/index.ts",
    `createInternalThreadRoutes(${threadDeps})`,
    `createInternalThreadRoutes(j1HistoryThreadDeps(internalCapability, internalSender${latestSource ? ", readInternalBody" : ""}))`,
  );
  const installPoint = latestSource
    ? 'for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => gracefulShutdown());'
    : 'for (const signal of ["SIGINT", "SIGTERM"] as const) {';
  await change(
    "server/index.ts",
    installPoint,
    `function j1HistoryCapability(who: HistoryPrincipal) {
  return who.kind === "mausbot" ? [...internalCapabilities.values()].find(cap => cap.kind === "agents" && cap.botId === who.botId && cap.threadId === who.threadId && cap.generation === who.generation && internalCapabilityIsActive(cap)) : undefined;
}
function j1HistoryThreadDeps(internalCapability: InternalCapability, internalSender: BotRecord${latestSource ? ', readInternalBody: () => Promise<unknown> = async () => { throw new Error("Thread lookup has no request body"); }' : ""}): Parameters<typeof createInternalThreadRoutes>[0] { return ${threadDeps}; }
function j1RoutingTarget(endpoint: { threadId: string }) {
  const match = /^mausbot:([\\w-]{1,120}):([\\w-]{1,120})$/.exec(endpoint.threadId);
  if (!match) return null;
  const threadId = match[2]!, bot = store.projectBotForTask(match[1]!, threadId), task = bot && store.taskByThread(bot.id, threadId);
  if (!bot || !task || bot.hidden || task.archivedAt !== undefined || proactive.fence.confines(threadId) || botApiThread(threadId)) return null;
  const busy = threadBusy(bot.id, threadId);
  const generation = busy ? directTurnGenerationByThread.get(threadId) ?? null : null;
  const instance = runningTurnEngines.get(threadId);
  return { allowed: unrestrictedRouteProfile(bot), blocked: Boolean(openPersonCard(threadId) || coordinator.awaitingAnswer(threadId) || computerSelectionTurns.get(threadId)?.selected || bot.approvalGrant || (busy && !generation)),
    generation, providerTurnId: generation ? directRequestOwners.get(threadId)?.turnId ?? null : null,
    canSteer: Boolean(instance && j1InputReady.get(threadId)?.generation === generation && ["codex", "claudeAgent"].includes(instance.driverKind) && instance.adapter.capabilities.queueing && instance.adapter.steer && canSteerThread(threadId)) };
}
const j1RouteReceiver = createNativeRouteReceiver({
  store, target: j1RoutingTarget,
  sourceCurrent: async delivery => await requestHostConversation({ kind: "routeSourceCheck", delivery }) === true,
  notify: requestHostConversation,
  steer: (endpoint, text) => steerThread(endpoint.threadId.split(":")[2]!, text),
  start: (endpoint, text, message, applied, failed) => startTurn(endpoint.threadId.split(":")[1]!, text, {
    threadId: endpoint.threadId.split(":")[2]!, userMessage: message, cardContinuation: true,
    requestMessageId: message.id, origin: OUTSIDE, commsDepth: 1, onTransport: applied, onDispatchError: failed,
  }),
});
const j1RoutingPhases = new Map<string, string>();
let j1WakePending = false;
store.onChange(change => {
  if (change.type !== "bot" && change.type !== "thread" && change.type !== "thread.deleted" && change.type !== "bot.deleted" && change.type !== "message" && change.type !== "message.patch") return;
  // Streamed text cannot release an approval or change turn admission.
  if ((change.type === "message" || change.type === "message.patch") && change.message.kind !== "options" && !change.message.card && !change.message.j1IncomingRoute) return;
  const threadIds = "threadId" in change ? [change.threadId] : store.tasks(change.botId).map(task => task.threadId);
  let changed = false;
  for (const threadId of threadIds) {
    const bot = store.botByThread(threadId) ?? store.bots.find(bot => store.taskByThread(bot.id, threadId));
    const endpoint = bot ? { threadId: "mausbot:" + bot.id + ":" + threadId } : null;
    const state = JSON.stringify(endpoint ? j1RoutingTarget(endpoint) : null);
    if (j1RoutingPhases.get(threadId) !== state) { j1RoutingPhases.set(threadId, state); changed = true; }
  }
  if (changed && !j1WakePending) { j1WakePending = true; queueMicrotask(() => { j1WakePending = false; void requestHostConversation({ kind: "routingWake" }).catch(() => {}); }); }
});
installConversationQueries(createConversationQueries({
  store,
  routingTarget: j1RoutingTarget, deliver: j1RouteReceiver,
  active: who => who.kind === "j1" || Boolean(j1HistoryCapability(who)),
  rows: who => {
    if (!who || who.kind === "j1") return store.bots.filter(bot => !bot.hidden).flatMap(bot => store.tasks(bot.id).filter(task => !proactive.fence.confines(task.threadId) && !botApiThread(task.threadId)).map(task => ({ botId: bot.id, threadId: task.threadId, title: task.title })));
    const cap = j1HistoryCapability(who);
    const bot = store.bot(who.botId);
    return cap && bot && connectorThread(bot.id, cap.threadId) ? internalThreadRows(j1HistoryThreadDeps(cap, bot)).slice(0, 100) : [];
  },
  generation: id => activeInternalGenerationByThread.get(id),
  waiting: id => coordinator.awaitingAnswer(id) || Boolean(openPersonCard(id)),
}));
${installPoint}`,
  );
  await copy(
    "scripts/mausbot/HiveMemorySection.tsx",
    "src/components/bot-settings/HiveMemorySection.tsx",
  );
  await change(
    "src/components/bot-settings/MemorySection.tsx",
    "import { FileText, FolderOpen, RotateCcw, Trash2 }",
    'import { HiveMemorySection } from "./HiveMemorySection";\nimport { FileText, FolderOpen, RotateCcw, Trash2 }',
  );
  await change(
    "src/components/bot-settings/MemorySection.tsx",
    '    <div className="flex flex-col gap-4">',
    '    <div className="flex flex-col gap-4">\n      <HiveMemorySection key={bot.id} botId={bot.id} active={active} busy={Boolean(bot.busy)} memoryEnabled={bot.memoryEnabled !== false} />',
  );
  await change(
    "server/routes/bot-memory.ts",
    'import { z } from "zod";',
    'import { z } from "zod";\nimport * as J1Memory from "../j1/hive-memory.ts";\nimport { ownerOrAdmin } from "../request-auth.ts";',
  );
  await change(
    "server/routes/bot-memory.ts",
    "bot(id: string): { id: string; memoryUpkeep?: boolean }",
    "bot(id: string): { id: string; threadId?: string; memoryEnabled?: boolean; busy?: boolean; memoryUpkeep?: boolean }",
  );
  await change(
    "server/routes/bot-memory.ts",
    "    m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/memory$/);",
    '    const hive = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/memory\\/hive$/);\n    if (hive) {\n      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only an owner can connect this assistantâ€™s notes to Hive Mind." });\n      const bot = deps.bot(hive[1]);\n      if (!bot) return json(res, 404, { error: "no such bot" });\n      try {\n        if (method === "GET") return json(res, 200, await J1Memory.status(bot.id));\n        if (method !== "PUT") return json(res, 405, { error: "method not allowed" });\n        const body = z.object({ enabled: z.boolean() }).strict().parse(await readBody(req));\n        if (body.enabled && (bot.memoryEnabled === false || bot.busy)) return json(res, 409, { error: "Enable memory and wait for this assistant to finish before connecting notes." });\n        return json(res, 200, await J1Memory.select(bot.id, body.enabled, bot.threadId ?? bot.id));\n      } catch { return json(res, 409, { error: "Hive Mind could not complete the request. Local notes are preserved; check J1â€™s Hive Mind connection." }); }\n    }\n    m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/memory$/);',
  );
  await change(
    "server/index.ts",
    "function autoRecallPrompt(bot:",
    'async function j1AutoRecallPrompt(bot: BotRecord, threadId: string, message: string, opts: { conversations: boolean; userName: PersonName }): Promise<string> {\n  const local = autoRecallPrompt(bot, threadId, message, opts);\n  if (bot.memoryEnabled === false || !autoRecallEnabled(cfg) || !opts.conversations) return local;\n  return [local, await J1Memory.recall(bot.id, threadId, message)].filter(Boolean).join("\\n\\n");\n}\nfunction autoRecallPrompt(bot:',
  );
  await change(
    "server/index.ts",
    "      const recalled = autoRecallPrompt(",
    "      const recalled = await j1AutoRecallPrompt(",
  );
  await change(
    "server/index.ts",
    'return json(res, result.ok ? 200 : result.code === "conflict" ? 409 : 400, result);',
    'return json(res, result.ok ? 200 : result.code === "conflict" ? 409 : 400, result.ok ? { ...result, ...await J1Memory.sync(internalSender.id, internalCapability.threadId) } : result);',
  );
  await change(
    "server/drivers/agents-call.ts",
    '    if (args.action === "forget") return { text: forgetText(String(args.old_text), r) };',
    '    if (r.hiveWarning) return { text: `${args.action === "forget" ? forgetText(String(args.old_text), r) : "Local memory updated."}\\n${String(r.hiveWarning)}`, isError: true };\n    if (args.action === "forget") return { text: forgetText(String(args.old_text), r) };',
  );
  await NodeFSP.copyFile(
    NodePath.join(stage, "electron/capabilities.cjs"),
    NodePath.join(stage, "server/j1/desktop-capabilities.cjs"),
  );
  await NodeFSP.writeFile(
    NodePath.join(stage, "server/j1/desktop-capabilities.d.cts"),
    "export function desktopCapabilities(options: Record<string, unknown>): Record<string, unknown>;\n",
  );
  await copy("scripts/mausbot/J1Navigation.tsx", "src/components/J1Navigation.tsx");
  await copy("scripts/mausbot/J1SearchBridge.tsx", "src/components/J1SearchBridge.tsx");
  await copy("scripts/mausbot/J1Appearance.ts", "src/components/J1Appearance.ts");
  await copy("packages/shared/src/mausbotAppearance.ts", "shared/j1-appearance.ts");
  await copy("scripts/mausbot/J1Settings.tsx", "src/components/J1Settings.tsx");
  await change(
    "src/components/AppNotices.tsx",
    "import { useSimpleModePromptSeen }",
    'import { useJ1Navigation } from "./J1Navigation";\nimport { useSimpleModePromptSeen }',
  );
  if (latestSource) {
    await change(
      "src/components/AppNotices.tsx",
      "  const simpleDue = SIMPLE_ONLY ? newLookDue : advancedBack || !promptSeen;",
      "  const merged = useJ1Navigation();\n  const simpleDue = !merged && (SIMPLE_ONLY ? newLookDue : advancedBack || !promptSeen);",
    );
  } else {
    await change(
      "src/components/AppNotices.tsx",
      "  const simpleDue = !useSimpleModePromptSeen();",
      "  const simpleSeen = useSimpleModePromptSeen();\n  const merged = useJ1Navigation();\n  const simpleDue = !merged && !simpleSeen;",
    );
  }
  if (!latestSource) {
    await change(
      "src/components/SidebarProfileMenu.tsx",
      "        onConnect: connectTo,\n        onGetApp: () => setPhoneAppOpen(true),",
      '        onConnect: (destination) => j1Navigation ? j1Post({ type: "settings-navigate", path: "/settings/connections" }) : connectTo(destination),\n        onGetApp: () => j1Navigation ? j1Post({ type: "settings-navigate", path: "/settings/connections" }) : setPhoneAppOpen(true),',
    );
  }
  await change(
    "src/components/SidebarProfileMenu.tsx",
    "    onAbout: () => setAboutOpen(true),",
    '    onAbout: () => j1Navigation ? j1Post({ type: "settings-navigate", path: "/settings/general", hash: "about" }) : setAboutOpen(true),',
  );
  // Product-label assertions follow J1's branding; bot identities and upstream provenance stay intact.
  await change(
    "src/components/SidebarProfileMenu.updates.test.ts",
    'toBe("Restart to update to MausBot 0.2.0")',
    'toBe("Restart to update to J1 Code 0.2.0")',
  );
  await change(
    "src/components/SidebarProfileMenu.test.ts",
    '      "Restart to update to MausBot 0.2.0",\n    );',
    '      "Restart to update to J1 Code 0.2.0",\n    );',
  );
  await change(
    "src/components/SidebarProfileMenu.test.ts",
    '.toBe("Install MausBot 0.2.0")',
    '.toBe("Install J1 Code 0.2.0")',
  );
  await change(
    "src/components/SidebarProfileMenu.tsx",
    'import { useEffect, useRef, useState } from "react";',
    'import { useEffect, useRef, useState } from "react";\nimport { useJ1Navigation, j1Post } from "./J1Navigation";',
  );
  // J1's original sidebar updater owns the bundled app. Do not offer a
  // second menu shortcut or enable the standalone bot updater in merged mode.
  await change(
    "src/components/SidebarProfileMenu.tsx",
    "  const serverUpdate = useServerUpdateItem(!window.ogb?.updater);",
    "  const j1Navigation = useJ1Navigation();\n  const serverUpdate = useServerUpdateItem(!window.ogb?.updater && !j1Navigation);",
  );
  const updateSource = latestSource ? "desktopUpdate ?? elsewhereUpdate ?? serverUpdate" : "desktopUpdate ?? serverUpdate";
  await change(
    "src/components/SidebarProfileMenu.tsx",
    `  const update = ${updateSource};`,
    `  const update = j1Navigation ? null : ${updateSource};`,
  );
  if (latestSource) await patchSettingsWindow(change);
  else await patchLegacySettingsWindow(change);
  await change(
    "src/lib/interface-mode.ts",
    'import { hasPriorRun } from "./prior-run";',
    "// J1 exposes the complete upstream navigation on first use; an explicit saved choice still wins.",
  );
  await change("src/lib/interface-mode.ts", "    return hasPriorRun(store);", "    return true;");
  await change(
    "src/lib/interface-mode.ts",
    "let sessionChoice: boolean | undefined;",
    "let sessionChoice: boolean | undefined;\nlet hostAdvanced = false;\n/** The merged J1 interface exposes the complete sidebar without overwriting the saved standalone choice. */\nexport function setHostAdvancedMode(enabled: boolean) {\n  if (hostAdvanced === enabled) return;\n  hostAdvanced = enabled;\n  notify();\n}",
  );
  await change(
    "src/lib/interface-mode.ts",
    "export function readAdvancedMode(): boolean {",
    "export function readAdvancedMode(): boolean {\n  if (hostAdvanced) return true;",
  );
  await copy("scripts/mausbot/host-interface.test.ts.txt", "src/lib/j1-host-interface.test.ts");
  const sidebarDeclaration = latestSource
    ? "export const Sidebar = memo(function Sidebar({"
    : "export function Sidebar({";
  await change(
    "src/components/Sidebar.tsx",
    sidebarDeclaration,
    `import { J1Navigation, useJ1Navigation, j1Post } from "./J1Navigation";\n${sidebarDeclaration}`,
  );
  await copy("scripts/mausbot/bot-drop-box.ts", "src/lib/j1-bot-drop-box.ts");
  await change(
    "src/components/SidebarBotDrag.tsx",
    "import { cn }",
    'import { botDropBox } from "@/lib/j1-bot-drop-box";\nimport { cn }',
  );
  await change(
    "src/components/SidebarBotDrag.tsx",
    "const rowDrop = (event: DragEvent<HTMLElement>, botId: string): BotDrop => {",
    "const rowDrop = (event: DragEvent<HTMLElement>, botId: string): BotDrop | null => {",
  );
  await change(
    "src/components/SidebarBotDrag.tsx",
    "    const box = event.currentTarget.getBoundingClientRect();",
    "    const box = botDropBox(event.currentTarget);\n    if (!box) return null;",
  );
  await change(
    "src/components/Sidebar.departments.test.ts",
    "currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 54 }), querySelectorAll:",
    "currentTarget: { closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 54, height: 54 }), querySelectorAll:",
  );
  await NodeFSP.appendFile(
    NodePath.join(stage, "src/components/Sidebar.departments.test.ts"),
    await NodeFSP.readFile(
      NodePath.join(root, "scripts/mausbot/bot-drop-clipping.test.ts.txt"),
      "utf8",
    ),
  );
  // A manually arranged merged roster must not jump when a bot starts working.
  // Group chiefs participate in their group's saved order just like other bots.
  if (latestSource) {
    await change(
      "src/components/Sidebar.tsx",
      " = sidebarBotRows(saved, floats, false);",
      ` = sidebarBotRows(j1Navigation ? {
    ...saved,
    sectionChiefs: [],
    sectionedBots: [...saved.sectionedBots, ...saved.sectionChiefs].sort((a, b) =>
      state.bots.findIndex((bot) => bot.id === a.id) - state.bots.findIndex((bot) => bot.id === b.id)),
  } : saved, floats, false);`,
    );
  } else {
  await change(
    "src/components/Sidebar.tsx",
    "  const { primary, unsectionedChief, pinnedBots, sectionChiefs, sectionedBots, unsectionedBots } = { ...saved, ...activeBotsFirst(saved, (bot) => {",
    "  const mergedSaved = j1Navigation ? { ...saved, sectionChiefs: [], sectionedBots: [...saved.sectionedBots, ...saved.sectionChiefs].sort((a, b) => state.bots.findIndex((bot) => bot.id === a.id) - state.bots.findIndex((bot) => bot.id === b.id)) } : saved;\n  const { primary, unsectionedChief, pinnedBots, sectionChiefs, sectionedBots, unsectionedBots } = { ...mergedSaved, ...activeBotsFirst(mergedSaved, (bot) => {",
  );
  await change(
    "src/components/Sidebar.tsx",
    "    return waiting || working;",
    "    return !j1Navigation && (waiting || working);",
  );
  await change(
    "src/components/Sidebar.tsx",
    "sectioned: saved.sectionedBots, departments: sectionNames",
    "sectioned: mergedSaved.sectionedBots, departments: sectionNames",
  );
  }
  await change(
    "src/components/DesktopWorkspaceSwitcher.tsx",
    "import { track }",
    'import { J1WorkspaceSwitcher, useJ1Navigation } from "./J1Navigation";\nimport { track }',
  );
  await change(
    "src/components/DesktopWorkspaceSwitcher.tsx",
    "  const places = usePlaces();",
    "  const places = usePlaces();\n  const j1Navigation = useJ1Navigation();\n  if (j1Navigation) return <J1WorkspaceSwitcher compact={props.compact} rail={props.rail} pill={props.pill} />;",
  );
  await change(
    "src/components/ChromeRailToggle.tsx",
    "import { cn }",
    'import { useJ1Navigation } from "./J1Navigation";\nimport { cn }',
  );
  await change(
    "src/components/ChromeRailToggle.tsx",
    "  if (!rail?.available) return null;\n  const label",
    "  const j1 = useJ1Navigation();\n  if (j1) return null; // The host titlebar owns the sidebar toggle.\n  if (!rail?.available) return null;\n  const label",
  );
  await change(
    "src/components/Sidebar.tsx",
    "          {matchingBots.length === 0",
    '          {j1Navigation && <div className="px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">Bots</div>}\n          {matchingBots.length === 0',
  );
  // The host keeps one sidebar toggle on every route. Reserve its space beside
  // the phone profile button instead of drawing a second toggle over it.
  await change(
    "src/components/Sidebar.tsx",
    '<div className="shrink-0" style={windowNoDragStyle}><SidebarProfileMenu iconOnly circle /></div>',
    '<div className={cn("shrink-0", j1Navigation && "ml-10")} style={windowNoDragStyle}><SidebarProfileMenu iconOnly circle /></div>',
  );
  await change(
    "src/components/Sidebar.tsx",
    "  const [searchOpen, setSearchOpen] = useState(false);",
    "  const j1Navigation = useJ1Navigation();\n  const [searchOpen, setSearchOpen] = useState(false);",
  );
  if (latestSource) {
    await change(
      "src/components/Sidebar.tsx",
      '<OtherPlaceLine query={query} icons={density === "icons"} /><MovedBotRows bots={state.bots} /><MovedToMyCloudRow bots={state.bots} /><SearchResults',
      '<J1Navigation />{!j1Navigation && <OtherPlaceLine query={query} icons={density === "icons"} />}<MovedBotRows bots={state.bots} />{!j1Navigation && <MovedToMyCloudRow bots={state.bots} />}<SearchResults',
    );
  } else {
    await change(
      "src/components/Sidebar.tsx",
      "          <MovedBotRows bots={state.bots} /><SearchResults",
      "          <J1Navigation />\n          <MovedBotRows bots={state.bots} /><SearchResults",
    );
  }
  await change(
    "src/components/Sidebar.tsx",
    "      <GlassScroller className=",
    "      <GlassScroller data-j1-sidebar-scroll className=",
  );
  await change(
    "src/components/Sidebar.tsx",
    "  const railSearch = () => {",
    '  const railSearch = () => {\n    if (j1Navigation) { j1Post({ type: "search-open" }); return; }',
  );
  await change(
    "src/components/Sidebar.tsx",
    "{simpleDesk && <SidebarSearchToggle",
    "{simpleDesk && !j1Navigation && <SidebarSearchToggle",
  );
  await change(
    "src/components/Sidebar.tsx",
    "      {phone ? null : simple ? searchShown && <SidebarSearchPill",
    '      {j1Navigation ? <div className={cn("px-3 pt-1 pb-3", density === "icons" && "hidden")}><button data-j1-shared-search type="button" onClick={() => j1Post({ type: "search-open" })} className={cn("flex h-8 w-full items-center gap-2 rounded-full px-3 text-left text-[13px] text-ink-secondary hover:text-ink", ELEVATED_CONTROL)} aria-label="Search bots, chats and projects"><Search size={15} />Search bots, chats and projects</button></div> : phone ? null : simple ? searchShown && <SidebarSearchPill',
  );
  await change(
    "src/components/Sidebar.tsx",
    "            onClick={openCommandPalette}",
    "            data-j1-shared-search\n            onClick={openCommandPalette}",
  );
  await change(
    "src/components/Sidebar.tsx",
    "onClick={railSearch}",
    "data-j1-shared-search onClick={railSearch}",
  );
  await change(
    "src/components/SidebarFooterNav.tsx",
    "import { SidebarSectionHeader }",
    'import { J1Footer } from "./J1Navigation";\nimport { SidebarSectionHeader }',
  );
  await change(
    "src/components/SidebarFooterNav.tsx",
    "      <SidebarAppsButton />",
    "      <J1Footer />\n      <SidebarAppsButton />",
  );
  await change(
    "src/components/Sidebar.tsx",
    "  const avatarSize = iconOnly",
    "  const merged = Boolean(useJ1Navigation());\n  const avatarSize = merged && !iconOnly ? 32 : iconOnly",
  );
  await change(
    "src/components/Sidebar.tsx",
    '    !iconOnly && "max-md:rounded-2xl max-md:py-2.5",',
    '    !iconOnly && "max-md:rounded-2xl max-md:py-2.5",\n    merged && !iconOnly && "gap-2 py-1.5 max-md:py-1.5",',
  );
  await change(
    "src/components/Sidebar.tsx",
    latestSource
      ? '"flex min-w-0 grow items-center gap-1.5 truncate text-ink", "text-[14px] font-medium leading-5"'
      : 'simpleRow ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5"',
    latestSource
      ? '"flex min-w-0 grow items-center gap-1.5 truncate text-ink", merged ? "text-[13px] font-medium leading-5" : "text-[14px] font-medium leading-5"'
      : 'merged ? "text-[13px] font-medium leading-5" : simpleRow ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5"',
  );
  if (!latestSource) {
  await change(
    "src/components/SettingsModal.tsx",
    "{visibleSections.length === 0 && (",
    "{!j1Navigation && visibleSections.length === 0 && (",
  );
  await change(
    "src/components/SettingsModal.tsx",
    'aria-current={section === id ? "page" : undefined}',
    'aria-current={(!j1Path || j1SettingsSection(j1Path) === id) && section === id ? "page" : undefined}',
  );
  await change(
    "src/components/SettingsModal.tsx",
    'section === id ? "bg-ink/[0.08]"',
    '(!j1Path || j1SettingsSection(j1Path) === id) && section === id ? "bg-ink/[0.08]"',
  );
  }
  await change(
    "src/components/CommandPalette.tsx",
    'import { t } from "@/lib/i18n";',
    'import { t } from "@/lib/i18n";\nimport { useJ1Navigation, j1Post } from "./J1Navigation";',
  );
  const paletteState = latestSource
    ? "  const [open, setOpen] = useState(false);"
    : "  const { state, dispatch } = useStore();";
  await change(
    "src/components/CommandPalette.tsx",
    paletteState,
    `${paletteState}\n  const j1Navigation = useJ1Navigation();`,
  );
  await change(
    "src/components/CommandPalette.tsx",
    "        setOpen((o) => !o);",
    '        if (j1Navigation) j1Post({ type: "search-open" }); else setOpen((o) => !o);',
  );
  await change(
    "src/components/CommandPalette.tsx",
    "    const onOpen = () => setOpen(true);",
    '    const onOpen = () => { if (j1Navigation) j1Post({ type: "search-open" }); else setOpen(true); };',
  );
  await change("src/components/CommandPalette.tsx", "  }, []);", "  }, [j1Navigation]);");
  await change(
    "src/App.tsx",
    "function Shell({ viewer }",
    'import { J1ShellBridge, useJ1Navigation, j1Post } from "@/components/J1Navigation";\nimport { J1SearchBridge } from "@/components/J1SearchBridge";\nimport { J1SettingsBridge } from "@/components/J1Settings";\nfunction Shell({ viewer }',
  );
  await change(
    "src/App.tsx",
    "  const { state, dispatch } = useStore();",
    '  const { state, dispatch } = useStore();\n  const j1Navigation = useJ1Navigation();\n  const j1ShowingProject = Boolean(j1Navigation && !["/", "/assistants"].includes(j1Navigation.active));',
  );
  const appFrame = latestSource
    ? "<WindowFrameBar notifications={notificationTray} sidebarUpdate={!advanced && sidebarShown} />"
    : "<WindowFrameBar notifications={notificationTray} />";
  await change(
    "src/App.tsx",
    `      ${appFrame}`,
    `      <J1ShellBridge /><J1SearchBridge /><J1SettingsBridge />\n      ${appFrame}`,
  );
  await change(
    "src/App.tsx",
    "collapseToIcons={collapseSidebar}",
    "collapseToIcons={j1Navigation ? !j1Navigation.sidebarOpen : collapseSidebar}",
  );
  await change(
    "src/App.tsx",
    "      {!calendarFocus && <button",
    "      {!calendarFocus && !j1Navigation && <button",
  );
  const syncDrawerFromJ1 = latestSource
    ? `
  useEffect(() => {
    if (!j1Navigation || !matchMedia("(max-width: 767px)").matches) return;
    if (j1ShowingProject || !j1Navigation.mobileOpen) hideDrawer();
    else openDrawer();
  }, [j1Navigation?.mobileOpen, j1ShowingProject, openDrawer, hideDrawer]);`
    : '\n  useEffect(() => { if (j1Navigation && matchMedia("(max-width: 767px)").matches) setDrawerOpen(j1Navigation.mobileOpen); }, [j1Navigation?.mobileOpen]);\n  useEffect(() => { if (j1Navigation && !["/", "/assistants"].includes(j1Navigation.active)) setDrawerOpen(false); }, [j1Navigation?.active]);';
  const drawerDeclaration = latestSource
    ? "    view: state.activeView, pluginsOpen: state.pluginsOpen, settingsOpen: state.settingsOpen });"
    : "  const [drawerOpen, setDrawerOpen] = useState(false);";
  await change(
    "src/App.tsx",
    drawerDeclaration,
    `${drawerDeclaration}${syncDrawerFromJ1}\n  useEffect(() => { j1Post({ type: "sidebar", open: drawerOpen }); }, [drawerOpen]);`,
  );
  await change(
    "src/App.tsx",
    '      {state.activeView === "team-map" ? (',
    '      {j1ShowingProject ? <main data-j1-main-slot className="min-w-0 flex-1 bg-app" /> : state.activeView === "team-map" ? (',
  );
  await change(
    "src/App.tsx",
    "      {state.computerOpen && bot && (",
    "      {!j1ShowingProject && state.computerOpen && bot && (",
  );
  await change(
    "src/App.tsx",
    "      {state.settingsOpen && bot && (",
    "      {!j1ShowingProject && state.settingsOpen && bot && (",
  );
  const roomPanel = latestSource ? "!state.forkPanel && roomPanelOpen && group" : "roomPanelOpen && group";
  await change(
    "src/App.tsx",
    `      {${roomPanel} && (`,
    `      {!j1ShowingProject && ${roomPanel} && (`,
  );
  await change(
    "src/App.tsx",
    "  const viewer = useWelcomeViewer();",
    '  const viewer = useWelcomeViewer();\n  const j1Navigation = useJ1Navigation();\n  const showWelcome = !j1Navigation || ["/", "/assistants"].includes(j1Navigation.active);',
  );
  await change(
    "src/App.tsx",
    "        <WelcomeGate viewer={viewer} />",
    "        {showWelcome && <WelcomeGate viewer={viewer} />}",
  );
  await change(
    "src/App.tsx",
    "        <MausBotWelcome viewer={viewer} />",
    "        {showWelcome && <MausBotWelcome viewer={viewer} />}",
  );
  await change("src/App.tsx", "        <GuidedTour />", "        {showWelcome && <GuidedTour />}");
  await change(
    "src/App.tsx",
    "        <FirstConversationTour quiet={spotlightsQuiet(viewer)} />",
    "        {showWelcome && <FirstConversationTour quiet={spotlightsQuiet(viewer)} />}",
  );
  await copy("scripts/mausbot/deepai-driver-config.ts", "server/j1/deepai-driver-config.ts");
  await copy("scripts/mausbot/deepai-driver.ts", "server/drivers/j1-deepai.ts");
  await change(
    "server/drivers/builtIn.ts",
    'import { PiDriver } from "./pi.ts";',
    'import { PiDriver } from "./pi.ts";\nimport { J1DeepAIDriver } from "./j1-deepai.ts";',
  );
  await change("server/drivers/builtIn.ts", "  PiDriver,", "  PiDriver,\n  J1DeepAIDriver,");
  await change(
    "server/config.ts",
    "  const map: InstanceConfigMap = withoutComputerEngine(configured ? { ...configured } : { ...DEFAULT_FLEET });",
    '  const map: InstanceConfigMap = withoutComputerEngine(configured ? { ...configured } : { ...DEFAULT_FLEET });\n  if (!Object.hasOwn(map, "j1-deepai")) map["j1-deepai"] = { driver: "j1-deepai", displayName: "DeepAI", access: "subscription", config: {} };',
  );
  await copy("apps/web/src/assets/deepai-mark.png", "src/assets/j1-deepai-mark.png");
  await change(
    "src/components/ProviderIcons.tsx",
    'import { cn } from "@/lib/cn";',
    'import { cn } from "@/lib/cn";\nimport deepAIMark from "../assets/j1-deepai-mark.png";',
  );
  await change(
    "src/components/ProviderIcons.tsx",
    '    case "piAgent":',
    '    case "j1-deepai":\n      return <span aria-hidden className={cn("inline-block shrink-0 bg-current", className)} style={{ width: size ?? 16, height: size ?? 16, maskImage: `url(${deepAIMark})`, maskSize: "contain", maskRepeat: "no-repeat" }} />;\n    case "piAgent":',
  );
  await copy("scripts/mausbot/J1Providers.tsx", "src/components/J1Providers.tsx");
  await change(
    "src/components/EnginesSettings.tsx",
    'import { t } from "@/lib/i18n";',
    'import { t } from "@/lib/i18n";\nimport { useJ1Navigation } from "./J1Navigation";\nimport { J1Providers } from "./J1Providers";',
  );
  await change(
    "src/components/EnginesSettings.tsx",
    "  const listed = state.instances.filter(",
    "  const j1Navigation = useJ1Navigation();\n  const listed = state.instances.filter(",
  );
  await change(
    "src/components/EnginesSettings.tsx",
    "  if (simple && more) return <>",
    "  if (j1Navigation?.providers) return <J1Providers instances={rows} renderEngine={renderEngine} refresh={<RefreshEngines />} extra={<>{orphanEndpoints && <ClaudeEndpoints />}<HiddenEngines /><CacheKeepWarmSettings /></>} />;\n  if (simple && more) return <>",
  );
  await change(
    "server/host/browser.ts",
    "    const engine = cleanupEngine();\n    const erased = async (name: string) => {",
    "    if (J1Browser.managed) { try { return session ? await J1Browser.forget(session) : true; } catch { return false; } }\n    const engine = cleanupEngine();\n    const erased = async (name: string) => {",
  );
  const browserEngineFile = NodePath.join(stage, "server/browser-engine.ts");
  await NodeFSP.writeFile(
    browserEngineFile,
    'import * as J1Browser from "./j1/native-browser.ts";\n' +
      (await NodeFSP.readFile(browserEngineFile, "utf8")),
  );
  await change(
    "server/browser-engine.ts",
    "  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(session)) return false;",
    "  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(session)) return false;\n  if (J1Browser.managed) { try { return await J1Browser.forget(session); } catch { return false; } }",
  );
  await copy("scripts/mausbot/native-browser.ts", "server/j1/native-browser.ts");
  await copy("scripts/mausbot/native-login-input.ts", "server/j1/native-login-input.ts");
  await copy("apps/server/src/mcp/LightpandaProcess.ts", "server/j1/LightpandaProcess.ts");
  const adapter = await NodeFSP.readFile(
    NodePath.join(root, "apps/server/src/mausbot/LightpandaAdapter.ts"),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(stage, "server/j1/LightpandaAdapter.ts"),
    adapter.replace("../mcp/LightpandaProcess.ts", "./LightpandaProcess.ts"),
  );
  const page = await NodeFSP.readFile(
    NodePath.join(root, "apps/server/src/mcp/toolkits/backgroundBrowser/page.ts"),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(stage, "server/j1/page-scripts.ts"),
    page
      .slice(page.indexOf("/** Produces"), page.indexOf("const call = Effect.fn"))
      .replace(/:\s*Exclude<BotBrowserAction, \{ type: "navigate" \| "open" \}>/, ": unknown"),
  );

  await change(
    "server/browser/engines.ts",
    'import { existsSync } from "node:fs";',
    'import * as J1Browser from "../j1/native-browser.ts";\nimport { existsSync } from "node:fs";',
  );
  await change(
    "server/browser/engines.ts",
    "result = await (target ? this.#chrome.service.agentRpc",
    "result = await (spec.command === J1Browser.command ? J1Browser.rpc(session, method, params, dispatch) : target ? this.#chrome.service.agentRpc",
  );
  await change(
    "server/browser/engines.ts",
    '    const refusal = method === "tools/call" ? this.#refusal?.(session, spec, params) : null;',
    '    // A stale upstream spec must not launch Chrome in a J1-owned runtime.\n    if (J1Browser.managed && spec.command !== J1Browser.command) return { isError: true, content: [{ type: "text", text: "This browser specification is no longer available. Reopen the J1 lightweight browser." }] };\n    const refusal = method === "tools/call" ? this.#refusal?.(session, spec, params) : null;',
  );
  await change(
    "server/browser/engines.ts",
    "return this.#chrome.service.working(session) || this.#old.working(session);",
    "return J1Browser.working(session) || this.#chrome.service.working(session) || this.#old.working(session);",
  );
  await change(
    "server/browser/engines.ts",
    "  withSecretInput<T extends { ok: boolean; text: string; held?: { url: string; ms: number } }>(session: string, spec: Spec, fn: () => Promise<T>, ctx?: StepContext): Promise<T> {",
    "  withSecretInput<T extends { ok: boolean; text: string; held?: { url: string; ms: number } }>(session: string, spec: Spec, fn: () => Promise<T>, ctx?: StepContext): Promise<T> {\n    if (J1Browser.managed) return J1Browser.withSecretInput(session, fn);",
  );
  await change(
    "server/browser/engines.ts",
    "await Promise.all([this.#chrome.service.close(session), this.#old.close(session)]);",
    "J1Browser.close(session);\n    await Promise.all([this.#chrome.service.close(session), this.#old.close(session)]);",
  );
  await change(
    "server/browser/engines.ts",
    "await Promise.all([this.#chrome.close(), this.#old.closeAll()]);",
    "await J1Browser.closeAll();\n    await Promise.all([this.#chrome.close(), this.#old.closeAll()]);",
  );

  await change(
    "server/host/browser.ts",
    'import { join } from "node:path";',
    'import * as J1Browser from "../j1/native-browser.ts";\nimport { join } from "node:path";',
  );
  await change(
    "server/host/browser.ts",
    "function onChrome(profile: string | undefined): boolean {",
    "function onChrome(profile: string | undefined): boolean {\n    if (J1Browser.managed) return false;",
  );
  await change(
    "server/host/browser.ts",
    '  function loginInput(session: string, spec: Spec, env: NodeJS.ProcessEnv): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click"> {',
    '  function loginInput(session: string, spec: Spec, env: NodeJS.ProcessEnv): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click"> {\n    if (J1Browser.managed) return J1Browser.loginInput(session);',
  );
  await change(
    "server/host/browser.ts",
    "function browserReady(profile: string | undefined): boolean {",
    "function browserReady(profile: string | undefined): boolean {\n    if (J1Browser.managed) return J1Browser.ready;",
  );
  const browserIntegration = "async function browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }, audience = browserAudience(turn?.threadId)";
  const browserIntegrationDeclaration = latestSource
    ? `${browserIntegration}, options: { opening?: string | null } = {}) {`
    : `${browserIntegration}) {`;
  await change(
    "server/host/browser.ts",
    browserIntegrationDeclaration,
    `${browserIntegrationDeclaration}
    if (J1Browser.managed) {
      if (!J1Browser.ready) return null;
      const session = currentBrowserSession(botId, profile, audience);
      const env: Record<string, string> = {};
      const spec = { command: J1Browser.command, args: [], env };
      usedBrowserSessions.set(session, spec);
      return { profile: "", session, spec, integration: turn ? turnIntegration(botId, session, turn) : spec };
    }`,
  );
  await change(
    "server/host/browser.ts",
    'async function currentBrowserSpec(botId: string, profile: string | undefined, audience: Audience = "team"): Promise<{ session: string; spec: Spec } | null> {',
    'async function currentBrowserSpec(botId: string, profile: string | undefined, audience: Audience = "team"): Promise<{ session: string; spec: Spec } | null> {\n    if (J1Browser.managed) return J1Browser.ready ? { session: currentBrowserSession(botId, profile, audience), spec: { command: J1Browser.command, args: [], env: {} } } : null;',
  );
  await change(
    "server/host/browser.ts",
    "function browserSystemPrompt(profile: string | undefined): string {",
    "function browserSystemPrompt(profile: string | undefined): string {\n    if (J1Browser.managed) return J1Browser.prompt;",
  );
  await change(
    "server/host/browser.ts",
    "async function closeBrowser(session: string, spec: Spec): Promise<boolean> {",
    "async function closeBrowser(session: string, spec: Spec): Promise<boolean> {\n    if (J1Browser.managed) { J1Browser.close(session); return true; }",
  );
  await change(
    "server/host/browser.ts",
    "      agentBrowserSweep.start();",
    "      if (J1Browser.managed) return browserSweep;\n      agentBrowserSweep.start();",
  );
  await change(
    "server/host/browser.ts",
    "    const serverSites = sitesSwitch ?",
    '    if (J1Browser.managed) return { ...agentBrowser, kind: J1Browser.ready ? "engine" : "unavailable", reason: J1Browser.ready ? undefined : "J1 lightweight browser is disabled or unavailable.", version: "j1-lightpanda", installable: false, myChrome: false, engine: "agent-browser" };\n    const serverSites = sitesSwitch ?',
  );

  await change(
    "server/routes/browser-viewers.ts",
    'import { createReadStream, rmSync } from "node:fs";',
    'import * as J1Browser from "../j1/native-browser.ts";\nimport { createReadStream, rmSync } from "node:fs";',
  );
  await change(
    "server/routes/browser-viewers.ts",
    "\\/browser\\/(live|action)$/",
    "\\/browser\\/(live|action|native)$/",
  );
  await change(
    "server/routes/browser-viewers.ts",
    "    if (live) {",
    '    if (live?.[2] === "native") {\n      if (!J1Browser.managed) return json(res, 404, { error: "Native browser is unavailable." });\n      if (method !== "GET" && method !== "POST") return json(res, 405, { error: "method not allowed" });\n      if (method === "POST" && !isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });\n      const body = method === "POST" ? await readBody(req, 32_768) : undefined;\n      if (!isCurrent()) return json(res, 409, { error: "This browser session changed." });\n      try { return json(res, 200, await J1Browser.page(browser.session, body)); }\n      catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "Browser unavailable." }); }\n    }\n    if (J1Browser.managed) return json(res, 409, { error: "Use J1â€™s lightweight browser panel." });\n\n    if (live) {',
  );
  await copy("scripts/mausbot/LightpandaPanel.tsx", "src/components/LightpandaPanel.tsx");
  const document = await NodeFSP.readFile(
    NodePath.join(root, "packages/client-runtime/src/bots/browserDocument.ts"),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(stage, "src/components/j1-browser-document.ts"),
    document.replace(
      'import type { BotBrowserPage } from "@j1code/contracts";',
      "export interface BotBrowserPage { revision: string; url: string; title: string; html: string }",
    ),
  );
  await change(
    "src/components/BrowserPanel.tsx",
    'import { api, useStore, type Bot } from "@/state/store";',
    'import { api, useStore, type Bot } from "@/state/store";\nimport { LightpandaPanel } from "./LightpandaPanel";',
  );
  await change(
    "src/components/BrowserPanel.tsx",
    '  if (engine?.kind === "engine" && !installing',
    '  if (engine?.version === "j1-lightpanda") return <LightpandaPanel key={bot.id} bot={bot} />;\n  if (engine?.kind === "engine" && !installing',
  );
  await copy("scripts/mausbot/client-base.ts", "src/j1-client-base.ts");
  await copy("scripts/mausbot/native-client.ts", "src/j1-native-client.ts");
  await change(
    "src/components/DesktopCapabilities.tsx",
    "type DesktopState = {",
    'import { subscribeNativeCapabilities } from "../j1-native-client";\ntype DesktopState = {',
  );
  await change(
    "src/components/DesktopCapabilities.tsx",
    "const unsubscribe = window.ogb?.onCapabilitiesChanged?.(",
    "const unsubscribe = subscribeNativeCapabilities(",
  );
  const configDecoder = latestSource
    ? 'import { configStatusFromFrame, type ConfigStatusFrame } from "@/lib/config-status-frame";'
    : "export function configStatusFromFrame(";
  await change(
    "src/state/store.tsx",
    configDecoder,
    `import { publishNativeCapabilities } from "../j1-native-client";\n${configDecoder}`,
  );
  const configDispatch = latestSource
    ? "forgetSharedSession();"
    : "\n          rawDispatch({";
  await change(
    "src/state/store.tsx",
    `        case "config":${latestSource ? " " : ""}${configDispatch}`,
    `        case "config":\n          publishNativeCapabilities(frame);${latestSource ? "\n          " : ""}${configDispatch}`,
  );
  await change(
    "src/state/store.tsx",
    '          return () => rawDispatch({ type: "configStatus", config });',
    '          return () => { publishNativeCapabilities(config); rawDispatch({ type: "configStatus", config }); };',
  );
  await change(
    "src/main.tsx",
    'import { StrictMode } from "react";',
    'import "./j1-client-base";\nimport { StrictMode } from "react";',
  );
  await change(
    "src/lib/brand.ts",
    'export const PRODUCT_NAME = "MausBot";',
    'export const PRODUCT_NAME = "J1 Code";',
  );
  await change(
    "server/index.ts",
    'import { desktopComputer, thisComputerNotReadyError } from "./desktop-computer.ts";',
    'import * as J1Browser from "./j1/native-browser.ts";\nimport * as J1Memory from "./j1/hive-memory.ts";\nimport { desktopCapabilities as j1DesktopCapabilities } from "./j1/desktop-capabilities.cjs";\nimport { desktopComputer, thisComputerNotReadyError } from "./desktop-computer.ts";\nlet j1ComputerDescriptor: unknown = null;\n// J1 supplies its owned native connection over private parent IPC.\nprocess.on("message", (message) => { if (desktopComputer.receive(message)) { j1ComputerDescriptor = (message as { connection: unknown }).connection; broadcast({ kind: "config", ...configStatus() }); if (message && typeof message === "object" && "requestId" in message && typeof message.requestId === "string") process.send?.({ type: "j1:computer-applied", requestId: message.requestId }); } });',
  );
  await change(
    "server/index.ts",
    "function configStatus() {",
    "function configStatus() {\n  return { ...j1OriginalConfigStatus(), j1Managed: true, j1DesktopCapabilities: j1DesktopCapabilities({ platform: process.platform, env: process.env, packaged: true, localConnection: j1ComputerDescriptor }) };\n}\nfunction j1OriginalConfigStatus() {",
  );
  await change(
    "server/index.ts",
    "  if (!utilityParentPort) return false;\n  try {\n    utilityParentPort.postMessage(message);",
    "  if (!utilityParentPort && !process.send) return false;\n  try {\n    if (utilityParentPort) utilityParentPort.postMessage(message);\n    else process.send?.(message);",
  );
  await change(
    "server/index.ts",
    'function computerPlaceRefusal(kind: ComputerKind): { message: string; code: "cloud_home" | "managed_policy" } | undefined {',
    'function computerPlaceRefusal(kind: ComputerKind): { message: string; code: "cloud_home" | "managed_policy" } | undefined {\n  if (J1Browser.managed && kind === "localVm") return { message: "Container desktops are not included in this J1 runtime. Choose This computer to use native tools.", code: "managed_policy" };',
  );
  await change(
    "server/index.ts",
    "async function readyLocalVmForTurn(botId: string, target: LocalVmTarget, isCurrent = () => true) {",
    'async function readyLocalVmForTurn(botId: string, target: LocalVmTarget, isCurrent = () => true) {\n  if (J1Browser.managed) throw new Error("Container desktops are not included in this J1 runtime. Choose This computer to use native tools.");',
  );
  const shutdownRegistration = latestSource ? installPoint : "  process.on(signal, gracefulShutdown);\n}";
  await change(
    "server/index.ts",
    shutdownRegistration,
    `${shutdownRegistration}\nif (process.send) {\n  process.on("message", (message) => { if (message && typeof message === "object" && "type" in message && message.type === "j1:shutdown") gracefulShutdown(); });\n  if (process.connected) process.once("disconnect", gracefulShutdown);\n  else gracefulShutdown();\n}`,
  );
  await change(
    "server/index.ts",
    '  if (process.connected) process.once("disconnect", gracefulShutdown);',
    '  process.on("message", (message) => {\n    if (message && typeof message === "object" && handleDesktopTrustedApprovalMessage(message)) return;\n    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "j1:browser" || !("executable" in message) || typeof message.executable !== "string" || !("requestId" in message) || typeof message.requestId !== "string") return;\n    J1Browser.configure(message.executable);\n    broadcast({ kind: "config", ...configStatus() });\n    process.send?.({ type: "j1:browser-applied", requestId: message.requestId });\n  });\n  if (process.connected) process.once("disconnect", gracefulShutdown);',
  );
  await patchMobileShell(stage, root, { settingsWindow: latestSource });
  await patchSharedExecution(stage, root, { settingsWindow: latestSource });
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  if (!process.argv[2]) throw new Error("Supply a disposable pinned OSS assembly directory.");
  await patchMausbotSource(NodePath.resolve(process.argv[2]));
}
