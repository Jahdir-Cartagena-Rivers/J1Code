import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { patchOpenMausImport } from "./patch-import.ts";

export const MAUSBOT_SOURCE = "d818c28aa80686dc1d7db64ebeffa2a9dc468762";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");

/** Applies only to our disposable, pinned OSS assembly; never edits the reference checkout. */
export async function patchMausbotSource(stage: string) {
  await patchOpenMausImport(stage);
  // OpenMausBot #4874: avoid spinning while many bot turns wait for memory.
  for (const file of ["e14bffd0-memory-queue.patch"])
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
  await NodeFSP.mkdir(NodePath.join(stage, "server/j1"), { recursive: true });
  await change(
    "src/state/config-status.ts",
    "export interface ConfigStatus {",
    "export interface ConfigStatus {\n  j1Managed?: boolean;",
  );
  await change("src/state/store.tsx", '  "xai" | "mistral"', '  "j1Managed" | "xai" | "mistral"');
  await change(
    "src/state/store.tsx",
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
  await change(
    "src/state/store.tsx",
    '"widget" | "app" | "fromApp"',
    '"j1RouteId" | "j1RouteRevision" | "widget" | "app" | "fromApp"',
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
    "stays ? `sticky top-[60px] bottom-[72px] z-10 ${ELEVATED_FLOAT}` : ELEVATED_CARD",
    "ELEVATED_CARD",
  );
  await change(
    "src/components/Composer.tsx",
    'import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";',
    'import { pendingApprovals } from "./PendingApproval";',
  );
  await change("src/components/Composer.tsx", "ELEVATED_CARD, ELEVATED_FLOAT", "ELEVATED_FLOAT");
  await change(
    "src/components/Composer.tsx",
    "  const approvalBot = group\n    ? members?.find((member) => member.id === approval?.message.from?.botId) ??\n      members?.find((member) => member.id === groupBusyBotId)\n    : state.bots.find((one) => one.id === approval?.message.inbox?.from.botId) ?? bot;\n",
    "",
  );
  await change(
    "src/components/Composer.tsx",
    `        {approval && (
          <div className={cn("mb-2 overflow-hidden rounded-[24px]", ELEVATED_CARD)}>
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
  await change(
    "shared/wire.ts",
    "export interface WireMessage extends ServerTextLine, HelperIntroField, SetupCardFields, WaitLineField, BugReportField {",
    "export interface WireMessage extends ServerTextLine, HelperIntroField, SetupCardFields, WaitLineField, BugReportField {\n  j1RouteId?: string;\n  j1RouteRevision?: number;\n  j1IncomingRoute?: { requestId: string; fingerprint: string; attemptId: string; state: 'sending' | 'rejected' | 'admitted' | 'applied' | 'uncertain'; generation?: string; providerTurnId?: string; environmentId?: string };",
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
  await change(
    "server/index.ts",
    "text: memorySystemPrompt(bot.id, { managedWrites: agentsMounted,",
    'text: (agentsMounted ? hiveProviderPrompt(toolScopeForTurn(bot.id), bot.memoryEnabled !== false) : "") + memorySystemPrompt(bot.id, { managedWrites: agentsMounted,',
  );
  await change(
    "server/index.ts",
    "text: memorySystemPrompt(teamHost.layer(bot.id, threadId),",
    'text: (integrations.agents ? hiveProviderPrompt(toolScopeForTurn(bot.id), bot.memoryEnabled !== false) : "") + memorySystemPrompt(teamHost.layer(bot.id, threadId),',
  );
  await change(
    "server/index.ts",
    "const roomMemory = memorySystemPrompt(",
    'const roomMemory = (integrations.agents ? hiveProviderPrompt(toolScopeForTurn(bot.id), bot.memoryEnabled !== false) : "") + memorySystemPrompt(',
  );
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
    "      return json(res, 200, { threads: rows.slice(0, 100) });",
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
    `export function internalThreadRows(deps: Parameters<typeof createInternalThreadRoutes>[0]): ThreadRow[] {\n  const { store, coordinator, from } = deps;\n${rowsBody}\n  return rows.slice(0, 100);\n}\n\ntype ThreadState =`,
  );
  await change(
    "server/index.ts",
    'import { createInternalThreadRoutes } from "./routes/internal-threads.ts";',
    'import { createInternalThreadRoutes, internalThreadRows } from "./routes/internal-threads.ts";\nimport { createConversationQueries, installConversationQueries, requestHostConversation, historyToolAllowed, type HistoryPrincipal } from "./j1/conversations.ts";\nimport { routingToolAllowed } from "./j1/agents-routing.ts";\nimport { hiveToolAllowed, parseHiveTool, hiveProviderPrompt } from "./j1/agents-hive-memory.ts";\nimport { createNativeRouteReceiver, unrestrictedRouteProfile } from "./j1/route-receiver.ts";',
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
        if (body.operation === "route_task" && internalCapability.depth >= MAX_COMMS_DEPTH) return json(res, 403, { error: "This delegated turn cannot forward work further." });
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
        ownsThread: (botId, threadId) => Boolean(connectorThread(botId, threadId)),
        shown: (id) => !proactive.fence.confines(id) && !botApiThread(id) && (CLOUD_TEAM ? teamHost.readableFrom(internalCapability.threadId)(id) : cloudLendingView(internalCapability) ? cloudOwnerOnlyThread(id) : true),
        threadBusy, queuedThreadPosition, queuedReason: queuedStatus,
      }`;
  await change(
    "server/index.ts",
    `createInternalThreadRoutes(${threadDeps})`,
    "createInternalThreadRoutes(j1HistoryThreadDeps(internalCapability, internalSender))",
  );
  await change(
    "server/index.ts",
    'for (const signal of ["SIGINT", "SIGTERM"] as const) {',
    `function j1HistoryCapability(who: HistoryPrincipal) {
  return who.kind === "mausbot" ? [...internalCapabilities.values()].find(cap => cap.kind === "agents" && cap.botId === who.botId && cap.threadId === who.threadId && cap.generation === who.generation && internalCapabilityIsActive(cap)) : undefined;
}
function j1HistoryThreadDeps(internalCapability: InternalCapability, internalSender: BotRecord): Parameters<typeof createInternalThreadRoutes>[0] { return ${threadDeps}; }
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
    return cap && bot && connectorThread(bot.id, cap.threadId) ? internalThreadRows(j1HistoryThreadDeps(cap, bot)) : [];
  },
  generation: id => activeInternalGenerationByThread.get(id),
  waiting: id => coordinator.awaitingAnswer(id) || Boolean(openPersonCard(id)),
}));
for (const signal of ["SIGINT", "SIGTERM"] as const) {`,
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
    '    const hive = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/memory\\/hive$/);\n    if (hive) {\n      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only an owner can connect this assistant’s notes to Hive Mind." });\n      const bot = deps.bot(hive[1]);\n      if (!bot) return json(res, 404, { error: "no such bot" });\n      try {\n        if (method === "GET") return json(res, 200, await J1Memory.status(bot.id));\n        if (method !== "PUT") return json(res, 405, { error: "method not allowed" });\n        const body = z.object({ enabled: z.boolean() }).strict().parse(await readBody(req));\n        if (body.enabled && (bot.memoryEnabled === false || bot.busy)) return json(res, 409, { error: "Enable memory and wait for this assistant to finish before connecting notes." });\n        return json(res, 200, await J1Memory.select(bot.id, body.enabled, bot.threadId ?? bot.id));\n      } catch { return json(res, 409, { error: "Hive Mind could not complete the request. Local notes are preserved; check J1’s Hive Mind connection." }); }\n    }\n    m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/memory$/);',
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
  await change(
    "src/components/AppNotices.tsx",
    "  const simpleDue = !useSimpleModePromptSeen();",
    "  const simpleSeen = useSimpleModePromptSeen();\n  const merged = useJ1Navigation();\n  const simpleDue = !merged && !simpleSeen;",
  );
  await change(
    "src/components/SidebarProfileMenu.tsx",
    "        onConnect: connectTo,\n        onGetApp: () => setPhoneAppOpen(true),",
    '        onConnect: (destination) => j1Navigation ? j1Post({ type: "settings-navigate", path: "/settings/connections" }) : connectTo(destination),\n        onGetApp: () => j1Navigation ? j1Post({ type: "settings-navigate", path: "/settings/connections" }) : setPhoneAppOpen(true),',
  );
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
  await change(
    "src/components/SidebarProfileMenu.tsx",
    "  const serverUpdate = useServerUpdateItem(!window.ogb?.updater);\n  const update = desktopUpdate ?? serverUpdate;",
    '  const j1Navigation = useJ1Navigation();\n  const serverUpdate = useServerUpdateItem(!window.ogb?.updater && !j1Navigation);\n  const update: UpdateEntry | null = j1Navigation ? { phase: "idle", pending: false, label: "J1 Code updates", item: { key: "update", label: "J1 Code updates", icon: <RefreshCw size={14} />, onSelect: () => j1Post({ type: "settings-navigate", path: "/settings/general", hash: "about" }) } } : desktopUpdate ?? serverUpdate;',
  );
  await change(
    "src/components/SettingsModal.tsx",
    'import { t } from "@/lib/i18n";',
    'import { t } from "@/lib/i18n";\nimport { J1SettingsLinks, J1SettingsSlot, j1SettingsSection, j1SettingsPath, j1SettingsLabel, j1OpenSettings, j1ExtraPages, j1Focusable, j1ActiveElement, j1SettingsPopupOpen } from "./J1Settings";\nimport { useJ1Navigation, j1Post, j1SettingsClosed } from "./J1Navigation";',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "  const advanced = useAdvancedMode();",
    '  const preferredAdvanced = useAdvancedMode();\n  const j1Navigation = useJ1Navigation();\n  const advanced = preferredAdvanced || Boolean(j1Navigation);\n  const j1Path = j1Navigation?.active.startsWith("/settings/") ? j1Navigation.active : null;\n  const j1Label = j1Navigation?.settingsPages?.find((page) => page.path === j1Path)?.label;',
  );
  await change(
    "src/components/SettingsModal.tsx",
    '        dispatch({ type: "toggleAppSettings", open: false });',
    '        j1SettingsClosed(); dispatch({ type: "toggleAppSettings", open: false });',
  );
  await change(
    "src/components/SettingsModal.tsx",
    '  const close = () => dispatch({ type: "toggleAppSettings", open: false });',
    '  const close = () => { j1SettingsClosed(); dispatch({ type: "toggleAppSettings", open: false }); };',
  );
  await change(
    "src/components/SettingsModal.tsx",
    '  const openSection = (id: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section: id });',
    '  const openSection = (id: AppSettingsSection) => { if (j1Navigation) j1OpenSettings(id); dispatch({ type: "toggleAppSettings", open: true, section: id }); };',
  );
  await change(
    "src/components/SettingsModal.tsx",
    '          {keyResultButtons("cursor-pointer flex min-h-9',
    '          {keyResultButtons("cursor-pointer flex min-h-9',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "              value={section}",
    "              value={j1Path && !j1SettingsSection(j1Path) ? `j1:${j1Path}` : section}",
  );
  await change(
    "src/components/SettingsModal.tsx",
    "                openSection(event.target.value as AppSettingsSection);",
    '                if (event.target.value.startsWith("j1:")) { j1Post({ type: "settings-navigate", path: event.target.value.slice(3) }); return; }\n                openSection(event.target.value as AppSettingsSection);',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "              {sectionLabelKey ? t(sectionLabelKey) : null}",
    "              {j1Path && !j1SettingsSection(j1Path) ? j1Label : sectionLabelKey ? j1Navigation ? j1SettingsLabel(section, t(sectionLabelKey)) : t(sectionLabelKey) : null}",
  );
  await change(
    "src/components/SettingsModal.tsx",
    "            <LicenseExpiryBanner config={state.config} />\n            {renderSection(section)}",
    '            {j1Path === "/settings/appearance" && <J1SettingsSlot />}\n            {(!j1Path || Boolean(j1SettingsSection(j1Path))) && !(j1Navigation && section === "companion") && <><LicenseExpiryBanner config={state.config} />{renderSection(section)}</>}\n            {j1Path === "/settings/keybindings" && <><TalkShortcutRow /><SendKeyRow /></>}\n            {j1Path && j1Path !== "/settings/appearance" && <J1SettingsSlot />}',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "            if (entries.length === 0) return null;",
    "            if (entries.length === 0 && !j1ExtraPages(j1Navigation?.settingsPages, group.id).length) return null;",
  );
  await change(
    "src/components/SettingsModal.tsx",
    "                ))}\n              </div>",
    "                ))}\n                <J1SettingsLinks query={query} group={group.id} />\n              </div>",
  );
  await change(
    "src/components/SettingsModal.tsx",
    "      const focusable = Array.from(\n        dialog.querySelectorAll<HTMLElement>(\n          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex=\"-1\"])',\n        ),\n      ).filter((element) => element.checkVisibility());",
    "      const focusable = j1Focusable(dialog);",
  );
  await change(
    "src/components/SettingsModal.tsx",
    "      const active = document.activeElement;",
    "      const active = j1ActiveElement();",
  );
  await change(
    "src/components/SettingsModal.tsx",
    "!dialog.contains(active)",
    "!dialog.contains(active?.getRootNode() instanceof ShadowRoot ? (active.getRootNode() as ShadowRoot).host : active)",
  );
  await change(
    "src/components/SettingsModal.tsx",
    '      if (event.key === "Escape") {',
    '      if (event.key === "Escape" && j1SettingsPopupOpen(dialog)) return;\n      if (event.key === "Escape") {',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "  const q = query.trim().toLowerCase();",
    "  useEffect(() => { if (j1Navigation && !j1Path && j1SettingsPath(section)) j1OpenSettings(section); }, [j1Navigation, j1Path, section]);\n  const q = query.trim().toLowerCase();",
  );
  for (const row of [
    "ThemeRow",
    "ChatWidthRow",
    "AdvancedModeRow",
    "OpenAtLoginRow",
    "UpdatesConsentRow",
    "UpdatesRow",
    "DiagnosticsRow",
    "AutomaticRecoverySettings",
    "ThreadCleanupSettings",
    "AttachmentStorageSettings",
    "TalkShortcutRow",
    "SendKeyRow",
  ]) {
    await change(
      "src/components/SettingsModal.tsx",
      `            <${row} />`,
      `            {!j1Navigation && <${row} />}`,
    );
  }
  await change(
    "src/components/SettingsModal.tsx",
    "                    {entries.map(({ id, labelKey }) => (\n                      <option key={id} value={id}>{t(labelKey)}</option>\n                    ))}",
    "                    {entries.map(({ id, labelKey }) => (\n                      <option key={id} value={id}>{j1Navigation ? j1SettingsLabel(id, t(labelKey)) : t(labelKey)}</option>\n                    ))}\n                    {j1ExtraPages(j1Navigation?.settingsPages, group.id).map((page) => <option key={page.path} value={`j1:${page.path}`}>{page.label}</option>)}",
  );
  await change(
    "src/components/SettingsModal.tsx",
    "{remoteActive && <AdvancedModeRow />}",
    "{remoteActive && !j1Navigation && <AdvancedModeRow />}",
  );
  await change(
    "src/components/SettingsModal.tsx",
    "                    {t(labelKey)}",
    "                    {j1Navigation ? j1SettingsLabel(id, t(labelKey)) : t(labelKey)}",
  );
  await change(
    "src/components/SettingsModal.tsx",
    '      case "backups": return <AdminOnly><WorkspaceBackupSettings /><CompanyBackupSettings /></AdminOnly>;',
    '      case "backups": return <AdminOnly>{j1Navigation && <><AutomaticRecoverySettings /><ThreadCleanupSettings /><AttachmentStorageSettings /></>}<WorkspaceBackupSettings /><CompanyBackupSettings /></AdminOnly>;',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "        return <><BuiltInBrowserRow /><ServerSitesRow /><BrowserProfilesRow /><AdminOnly><LocalComputerSection /></AdminOnly></>;",
    "        return <>{!j1Navigation && <><BuiltInBrowserRow /><ServerSitesRow /><BrowserProfilesRow /></>}<AdminOnly><LocalComputerSection /></AdminOnly></>;",
  );
  await change(
    "src/components/SettingsModal.tsx",
    '    if (nextVisibleSection) dispatch({ type: "toggleAppSettings", open: true, section: nextVisibleSection });',
    '    if (nextVisibleSection && !j1Path) dispatch({ type: "toggleAppSettings", open: true, section: nextVisibleSection });',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "  }, [dispatch, nextVisibleSection]);",
    "  }, [dispatch, nextVisibleSection, j1Path]);",
  );
  await change(
    "src/components/SkinPicker.tsx",
    'import { Check } from "lucide-react";',
    'import { Check } from "lucide-react";\nimport { useJ1Navigation } from "./J1Navigation";',
  );
  await change(
    "src/components/SkinPicker.tsx",
    "  const active = resolveSkin(useSkinChoice());",
    '  const active = resolveSkin(useSkinChoice());\n  const merged = Boolean(useJ1Navigation());\n  if (merged) return active === "halloween" ? <DressUpRow /> : null;',
  );
  await change(
    "src/components/SettingsModal.tsx",
    '            <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>\n              <SkinPicker />\n            </Card>',
    '            {j1Navigation ? <SkinPicker /> : <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>\n              <SkinPicker />\n            </Card>}',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "            <FontRow />",
    "            {!j1Navigation && <FontRow />}",
  );
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
  await change(
    "src/components/Sidebar.tsx",
    "export function Sidebar({",
    'import { J1Navigation, useJ1Navigation, j1Post } from "./J1Navigation";\nexport function Sidebar({',
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
    'import { j1Post, useJ1Navigation } from "./J1Navigation";\nimport { cn }',
  );
  await change(
    "src/components/ChromeRailToggle.tsx",
    "  if (!rail?.available) return null;\n  const label",
    '  const j1 = useJ1Navigation();\n  if (j1) return <button type="button" data-rail-toggle aria-label="Toggle main sidebar" title="Toggle main sidebar" aria-expanded={j1.sidebarOpen} onClick={() => j1Post({ type: "sidebar-toggle" })} className={bar ?? SIMPLE_TOP_TOGGLE} style={style}><RailStripIcon size={bar ? 15 : 18} /></button>;\n  if (!rail?.available) return null;\n  const label',
  );
  await change(
    "src/components/Sidebar.tsx",
    "          {matchingBots.length === 0",
    '          {j1Navigation && <div className="px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">Bots</div>}\n          {matchingBots.length === 0',
  );
  await change(
    "src/components/Sidebar.tsx",
    "  const [searchOpen, setSearchOpen] = useState(false);",
    "  const j1Navigation = useJ1Navigation();\n  const [searchOpen, setSearchOpen] = useState(false);",
  );
  await change(
    "src/components/Sidebar.tsx",
    "          <MovedBotRows bots={state.bots} /><SearchResults",
    "          <J1Navigation />\n          <MovedBotRows bots={state.bots} /><SearchResults",
  );
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
    'simpleRow ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5"',
    'merged ? "text-[13px] font-medium leading-5" : simpleRow ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5"',
  );
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
  await change(
    "src/components/CommandPalette.tsx",
    'import { t } from "@/lib/i18n";',
    'import { t } from "@/lib/i18n";\nimport { useJ1Navigation, j1Post } from "./J1Navigation";',
  );
  await change(
    "src/components/CommandPalette.tsx",
    "  const { state, dispatch } = useStore();",
    "  const { state, dispatch } = useStore();\n  const j1Navigation = useJ1Navigation();",
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
  await change(
    "src/App.tsx",
    "      <WindowFrameBar notifications={notificationTray} />",
    "      <J1ShellBridge /><J1SearchBridge /><J1SettingsBridge />\n      <WindowFrameBar notifications={notificationTray} />",
  );
  await change(
    "src/App.tsx",
    "collapseToIcons={collapseSidebar}",
    "collapseToIcons={j1Navigation ? !j1Navigation.sidebarOpen : collapseSidebar}",
  );
  await change(
    "src/App.tsx",
    "  const [drawerOpen, setDrawerOpen] = useState(false);",
    '  const [drawerOpen, setDrawerOpen] = useState(false);\n  useEffect(() => { if (j1Navigation && matchMedia("(max-width: 767px)").matches) setDrawerOpen(j1Navigation.mobileOpen); }, [j1Navigation?.mobileOpen]);\n  useEffect(() => { if (j1Navigation && !["/", "/assistants"].includes(j1Navigation.active)) setDrawerOpen(false); }, [j1Navigation?.active]);\n  useEffect(() => { j1Post({ type: "sidebar", open: drawerOpen }); }, [drawerOpen]);',
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
  await change(
    "src/App.tsx",
    "      {roomPanelOpen && group && (",
    "      {!j1ShowingProject && roomPanelOpen && group && (",
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
  await copy("scripts/mausbot/native-browser.ts", "server/j1/native-browser.ts");
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
    "await Promise.all([this.#chrome.service.close(session), this.#old.close(session)]);",
    "J1Browser.close(session);\n    await Promise.all([this.#chrome.service.close(session), this.#old.close(session)]);",
  );
  await change(
    "server/browser/engines.ts",
    "await Promise.all([this.#chrome.close(), this.#old.closeAll()]);",
    "J1Browser.closeAll();\n    await Promise.all([this.#chrome.close(), this.#old.closeAll()]);",
  );

  await change(
    "server/host/browser.ts",
    'import { existsSync } from "node:fs";',
    'import * as J1Browser from "../j1/native-browser.ts";\nimport { existsSync } from "node:fs";',
  );
  await change(
    "server/host/browser.ts",
    "function onChrome(profile: string | undefined): boolean {",
    "function onChrome(profile: string | undefined): boolean {\n    if (J1Browser.managed) return false;",
  );
  await change(
    "server/host/browser.ts",
    "function browserReady(profile: string | undefined): boolean {",
    "function browserReady(profile: string | undefined): boolean {\n    if (J1Browser.managed) return J1Browser.ready;",
  );
  await change(
    "server/host/browser.ts",
    "async function browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }, audience = browserAudience(turn?.threadId)) {",
    'async function browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }, audience = browserAudience(turn?.threadId)) {\n    if (J1Browser.managed) {\n      if (!J1Browser.ready) return null;\n      const session = currentBrowserSession(botId, profile, audience);\n      const env: Record<string, string> = {};\n      const spec = { command: J1Browser.command, args: [], env };\n      usedBrowserSessions.set(session, spec);\n      return { profile: "", session, spec, integration: turn ? turnIntegration(botId, session, turn) : spec };\n    }',
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
    '    if (live?.[2] === "native") {\n      if (!J1Browser.managed) return json(res, 404, { error: "Native browser is unavailable." });\n      if (method !== "GET" && method !== "POST") return json(res, 405, { error: "method not allowed" });\n      if (method === "POST" && !isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });\n      const body = method === "POST" ? await readBody(req, 32_768) : undefined;\n      if (!isCurrent()) return json(res, 409, { error: "This browser session changed." });\n      try { return json(res, 200, await J1Browser.page(browser.session, body)); }\n      catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "Browser unavailable." }); }\n    }\n    if (J1Browser.managed) return json(res, 409, { error: "Use J1’s lightweight browser panel." });\n\n    if (live) {',
  );
  await copy("scripts/mausbot/LightpandaPanel.tsx", "src/components/LightpandaPanel.tsx");
  const document = await NodeFSP.readFile(
    NodePath.join(root, "packages/client-runtime/src/bots/browserDocument.ts"),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(stage, "src/components/j1-browser-document.ts"),
    document.replace(
      'import type { BotBrowserPage } from "@t3tools/contracts";',
      "export interface BotBrowserPage { revision: string; url: string; title: string; html: string }",
    ),
  );
  await change(
    "src/components/BrowserPanel.tsx",
    'import { useCallback, useEffect, useRef, useState } from "react";',
    'import { LightpandaPanel } from "./LightpandaPanel";\nimport { useCallback, useEffect, useRef, useState } from "react";',
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
  await change(
    "src/state/store.tsx",
    "export function configStatusFromFrame(",
    'import { publishNativeCapabilities } from "../j1-native-client";\nexport function configStatusFromFrame(',
  );
  await change(
    "src/state/store.tsx",
    '        case "config":\n          rawDispatch({',
    '        case "config":\n          publishNativeCapabilities(frame);\n          rawDispatch({',
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
  await change(
    "server/index.ts",
    "  process.on(signal, gracefulShutdown);\n}",
    '  process.on(signal, gracefulShutdown);\n}\nif (process.send) {\n  process.on("message", (message) => { if (message && typeof message === "object" && "type" in message && message.type === "j1:shutdown") gracefulShutdown(); });\n  if (process.connected) process.once("disconnect", gracefulShutdown);\n  else gracefulShutdown();\n}',
  );
  await change(
    "server/index.ts",
    '  if (process.connected) process.once("disconnect", gracefulShutdown);',
    '  process.on("message", (message) => {\n    if (message && typeof message === "object" && handleDesktopTrustedApprovalMessage(message)) return;\n    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "j1:browser" || !("executable" in message) || typeof message.executable !== "string" || !("requestId" in message) || typeof message.requestId !== "string") return;\n    J1Browser.configure(message.executable);\n    broadcast({ kind: "config", ...configStatus() });\n    process.send?.({ type: "j1:browser-applied", requestId: message.requestId });\n  });\n  if (process.connected) process.once("disconnect", gracefulShutdown);',
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  if (!process.argv[2]) throw new Error("Supply a disposable pinned OSS assembly directory.");
  await patchMausbotSource(NodePath.resolve(process.argv[2]));
}
