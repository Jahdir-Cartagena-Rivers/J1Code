import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** All replacements are pinned; an upstream layout change fails the assembly. */
export async function patchSharedExecution(stage: string, root: string) {
  const change = async (file: string, before: string, after: string) => {
    const path = NodePath.join(stage, file);
    const source = (await NodeFSP.readFile(path, "utf8")).replaceAll("\r\n", "\n");
    if (source.split(before).length !== 2)
      throw new Error(`Pinned shared execution source changed: ${file}`);
    await NodeFSP.writeFile(path, source.replace(before, after));
  };
  await change(
    "src/components/Sidebar.tsx",
    'ref={sidebarRef} data-sidebar-root={!phone || open ? "" : undefined}',
    'ref={sidebarRef} data-sidebar-root={!phone || open ? "" : undefined} data-j1-sidebar-overlay={phone && open ? "" : undefined}',
  );
  await change(
    "src/components/SettingsModal.tsx",
    '<div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto',
    '<div ref={scrollRef} data-j1-settings-scroll className="flex flex-1 flex-col gap-4 overflow-y-auto',
  );
  await change(
    "src/components/AppNotices.tsx",
    '  const boatHere = boatOfferRuns(now()) && brandStatus().source !== "file";',
    '  const boatHere = !state.config?.j1Managed && boatOfferRuns(now()) && brandStatus().source !== "file";',
  );
  await change(
    "src/components/BoatOffer.tsx",
    'import { Gift, Mail } from "lucide-react";',
    'import { Gift, Mail } from "lucide-react";\nimport { useStore } from "@/state/store";',
  );
  await change(
    "src/components/BoatOffer.tsx",
    '  if (!boatOfferRuns(Date.now()) || brandStatus().source === "file") return null;',
    '  const { state } = useStore();\n  if (state.config?.j1Managed || !boatOfferRuns(Date.now()) || brandStatus().source === "file") return null;',
  );
  await NodeFSP.copyFile(
    NodePath.join(root, "scripts/mausbot/shared-execution.ts"),
    NodePath.join(stage, "server/drivers/j1-shared.ts"),
  );
  await NodeFSP.copyFile(
    NodePath.join(root, "scripts/mausbot/shared-execution.test.ts.txt"),
    NodePath.join(stage, "server/drivers/j1-shared.test.ts"),
  );
  for (const [source, destination] of [
    ["shared-execution-client.ts", "server/drivers/j1-shared-client.ts"],
    ["shared-selection.ts", "server/j1-shared-selection.ts"],
    ["shared-selection.test.ts.txt", "server/j1-shared-selection.test.ts"],
    ["shared-store.test.ts.txt", "server/j1-shared-store.test.ts"],
    ["engineering-team.ts", "server/j1-engineering.ts"],
    ["engineering-team.test.ts.txt", "server/j1-engineering.test.ts"],
    ["shared-project-routes.test.ts.txt", "server/j1-shared-project-routes.test.ts"],
    ["J1EngineeringTeam.tsx", "src/components/J1EngineeringTeam.tsx"],
  ])
    await NodeFSP.copyFile(
      NodePath.join(root, "scripts/mausbot", source!),
      NodePath.join(stage, destination!),
    );
  const engineeringSource = await NodeFSP.readFile(
    NodePath.join(root, "scripts/mausbot/engineering-team/engineering.md"),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(stage, "server/j1-engineering-blueprint.ts"),
    `// Engineering blueprint from milind-soni/openmausbot-teams, blob 4447f18d6ec54ce584dda11f249530faa3b5c37e. MIT; see engineering-team.LICENSE.\nexport const engineeringSource = ${JSON.stringify(engineeringSource)};\n`,
  );
  await NodeFSP.copyFile(
    NodePath.join(root, "scripts/mausbot/engineering-team/LICENSE"),
    NodePath.join(stage, "engineering-team.LICENSE"),
  );
  await change(
    "server/routes/bot-settings.ts",
    'import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";',
    'import { setupEngineeringTeam } from "../j1-engineering.ts";\nimport { sharedAccountLinks } from "../j1-shared-selection.ts";\nimport { sharedCatalog } from "../drivers/j1-shared-client.ts";\nimport { instanceConfigs } from "../config.ts";\nimport { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";',
  );
  await change(
    "server/routes/bot-settings.ts",
    "    let m: RegExpMatchArray | null = null;",
    `    if (process.send && path === "/api/j1/provider-links" && method === "GET") {
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Provider settings require workspace administration." });
      return json(res, 200, sharedAccountLinks(instanceConfigs(cfg), await sharedCatalog()));
    }
    if (process.send && path === "/api/j1/engineering" && method === "POST") {
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Engineering setup requires workspace administration." });
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || typeof body.leadBotId !== "string")
        return json(res, 400, { error: "Select an existing engineering lead." });
      try { return json(res, 200, setupEngineeringTeam(store, body.leadBotId)); }
      catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "Engineering setup did not complete." }); }
    }
    let m: RegExpMatchArray | null = null;`,
  );
  await change(
    "server/index.ts",
    "const firstEngineRead = holdUntilFirstEngineRead();",
    `let j1Catalog = process.send ? await sharedCatalog().catch(() => []) : [];
const firstEngineRead = holdUntilFirstEngineRead();`,
  );
  await change(
    "server/index.ts",
    'import { ENGINE_LIST_REUSE_MS, engineMemory, enginesByUse, ProviderRegistry } from "./harness/registry.ts";',
    'import { sharedCatalog, onSharedExecution, sharedExecutionRequest } from "./drivers/j1-shared-client.ts";\nimport { sharedSelection } from "./j1-shared-selection.ts";\nimport { ENGINE_LIST_REUSE_MS, engineMemory, enginesByUse, ProviderRegistry } from "./harness/registry.ts";',
  );
  await change(
    "server/index.ts",
    "  return selectDefaultModelSelection(selectableInstances(instances ?? await registry.describe()), saved ?? undefined, selectionContext);",
    "  return sharedSelection(selectDefaultModelSelection(selectableInstances(instances ?? await registry.describe()), saved ?? undefined, selectionContext), providerConfigs(), j1Catalog);",
  );
  await change(
    "server/index.ts",
    "const outsideLineage = createOutsideLineage({",
    `store.migrateJ1SharedSelections((selection, mode, scope) => sharedSelection(selection, providerConfigs(), j1Catalog, mode, scope));
if (process.send) {
  onSharedExecution(event => {
    if (event.kind !== "catalog" || !Array.isArray(event.catalog)) return;
    j1Catalog = event.catalog as typeof j1Catalog;
    try { store.migrateJ1SharedSelections((selection, mode, scope) => sharedSelection(selection, providerConfigs(), j1Catalog, mode, scope)); }
    catch { console.warn("Shared account migration could not be saved; the existing selections are preserved."); }
  });
  void sharedExecutionRequest({ action: "watch-catalog" }).catch(() => {});
}
const outsideLineage = createOutsideLineage({`,
  );
  await change(
    "server/store.ts",
    "  applyModelDefault(id: string, modelSelection: ModelSelection): BotRecord | null {",
    `  /** One durable migration; native cursors and all saved histories remain available for a manual switch back. */
  migrateJ1SharedSelections(map: (selection: ModelSelection, mode: string, scope: BotRecord["toolScope"]) => ModelSelection): void {
    let changed = false;
    const next = this.bots.map(bot => {
      const modelSelection = map(bot.modelSelection, approvalModeFor(bot), bot.toolScope);
      const tasks = bot.tasks?.map(task => {
        const effective = this.projectBotForTask(bot.id, task.threadId)!;
        const previous = task.modelSelection ?? bot.modelSelection;
        const desired = map(previous, approvalModeFor(effective), effective.toolScope);
        const selection = task.modelSelection ? desired : modelSelection !== bot.modelSelection && desired === previous ? previous : undefined;
        if (selection === task.modelSelection) return task;
        changed = true;
        return { ...task, modelSelection: selection };
      });
      if (modelSelection === bot.modelSelection && tasks?.every((task, index) => task === bot.tasks?.[index])) return bot;
      changed = true;
      return { ...bot, modelSelection, tasks };
    });
    if (!changed) return;
    this.saveBots(next);
    this.bots = next;
  }

  applyModelDefault(id: string, modelSelection: ModelSelection): BotRecord | null {`,
  );
  await NodeFSP.copyFile(
    NodePath.join(root, "scripts/mausbot/J1ProjectBinding.tsx"),
    NodePath.join(stage, "src/components/J1ProjectBinding.tsx"),
  );
  await change(
    "server/drivers/builtIn.ts",
    'import { PiDriver } from "./pi.ts";',
    'import { PiDriver } from "./pi.ts";\nimport { J1SharedDriver } from "./j1-shared.ts";',
  );
  await change("server/drivers/builtIn.ts", "  PiDriver,", "  PiDriver,\n  J1SharedDriver,");
  await change(
    "server/config.ts",
    "  const map: InstanceConfigMap = withoutComputerEngine(configured ? { ...configured } : { ...DEFAULT_FLEET });",
    '  const map: InstanceConfigMap = withoutComputerEngine(configured ? { ...configured } : { ...DEFAULT_FLEET });\n  if (process.send && !Object.hasOwn(map, "j1-shared")) map["j1-shared"] = { driver: "j1-shared", displayName: "J1 shared providers", access: "subscription", config: {} };',
  );
  await change(
    "server/contracts.ts",
    "export interface SendTurnInput {",
    "export interface SendTurnInput {\n  j1BotName?: string;\n  j1ProjectId?: string;",
  );
  await change(
    "shared/wire.ts",
    "export interface WireBot extends DefaultBotFields, BotAccessFields {",
    "export interface WireBot extends DefaultBotFields, BotAccessFields {\n  j1ProjectId?: string;",
  );
  await change(
    "shared/wire.ts",
    "export interface WireTask extends InboxTask {",
    "export interface WireTask extends InboxTask {\n  j1ProjectId?: string;",
  );
  await change(
    "server/store.ts",
    '  "title", "projectId", "modelSelection",',
    '  "j1ProjectId", "title", "projectId", "modelSelection",',
  );
  await change(
    "server/store.ts",
    "      approvalGrant: bot.approvalGrant?.threadOnly && bot.approvalGrant.threadId !== threadId ? undefined : bot.approvalGrant,",
    "      j1ProjectId: task.j1ProjectId ?? bot.j1ProjectId,\n      approvalGrant: bot.approvalGrant?.threadOnly && bot.approvalGrant.threadId !== threadId ? undefined : bot.approvalGrant,",
  );
  await change(
    "server/index.ts",
    "        botId: bot.id,\n        startupRecovery,",
    "        botId: bot.id,\n        j1BotName: bot.name,\n        ...(bot.j1ProjectId ? { j1ProjectId: bot.j1ProjectId } : {}),\n        startupRecovery,",
  );
  await change(
    "server/routes/bot-settings.ts",
    'import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";',
    'import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";\nimport { sharedExecutionRequest } from "../drivers/j1-shared-client.ts";',
  );
  await change(
    "server/routes/bot-settings.ts",
    "    let m: RegExpMatchArray | null = null;",
    `    if (path === "/api/j1/projects" && method === "GET") {
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Project binding requires workspace administration." });
      try { return json(res, 200, await sharedExecutionRequest({ action: "projects" })); }
      catch { return json(res, 503, { error: "J1 projects are unavailable." }); }
    }
    if (path === "/api/j1/thread-project" && (method === "GET" || method === "PATCH")) {
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Project binding requires workspace administration." });
      const body = method === "PATCH" ? await readBody(req) : { botId: url.searchParams.get("botId"), threadId: url.searchParams.get("threadId") };
      if (!body || typeof body.botId !== "string" || typeof body.threadId !== "string") return json(res, 400, { error: "Select an existing bot thread." });
      const bot = store.projectBotForTask(body.botId, body.threadId);
      if (!bot) return json(res, 404, { error: "No such bot thread." });
      const saved = await sharedExecutionRequest({ action: "binding", botId: body.botId, threadId: body.threadId }) as { locked: boolean; projectId?: string };
      if (method === "GET") return json(res, 200, { locked: saved.locked, projectId: saved.locked ? saved.projectId : bot.j1ProjectId ?? "" });
      if (Object.keys(body).some(key => !["botId", "threadId", "projectId"].includes(key)) || typeof body.projectId !== "string") return json(res, 400, { error: "Select a J1 project." });
      if (bot.busy) return json(res, 409, { error: "Wait for this thread's active turn to finish." });
      if (saved.locked && body.projectId !== saved.projectId) return json(res, 409, { error: "Start a new bot thread to change its project; this session is preserved." });
      const projects = await sharedExecutionRequest({ action: "projects" });
      if (body.projectId && (!Array.isArray(projects) || !projects.some(project => project.id === body.projectId))) return json(res, 400, { error: "Select an existing J1 project." });
      store.patchTask(body.botId, body.threadId, { j1ProjectId: body.projectId });
      return json(res, 200, { projectId: body.projectId, locked: saved.locked });
    }
    let m: RegExpMatchArray | null = null;`,
  );
  await change(
    "server/routes/bot-patch.ts",
    'import { z } from "zod";',
    'import { z } from "zod";\nimport { sharedExecutionRequest } from "../drivers/j1-shared-client.ts";',
  );
  await change(
    "server/routes/bot-patch.ts",
    "      Object.assign(patch, profile.patch);",
    `      Object.assign(patch, profile.patch);
      if (Object.hasOwn(body, "j1ProjectId")) {
        if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Project binding requires workspace administration." });
        if (body.j1ProjectId === "") patch.j1ProjectId = undefined;
        else {
          const projects = await sharedExecutionRequest({ action: "projects" });
          if (typeof body.j1ProjectId !== "string" || !Array.isArray(projects) || !projects.some(project => project.id === body.j1ProjectId))
            return json(res, 400, { error: "Select an existing J1 project." });
          patch.j1ProjectId = body.j1ProjectId;
        }
      }`,
  );
  await change(
    "src/state/store.tsx",
    'export interface Bot extends DefaultBotFields, Pick<WireBot, "mascotFaceColor" | "access" | "yourAccess" | "onlyPeopleAdded"> {',
    'export interface Bot extends DefaultBotFields, Pick<WireBot, "mascotFaceColor" | "access" | "yourAccess" | "onlyPeopleAdded"> {\n  j1ProjectId?: string;',
  );
  for (const file of [
    "src/components/bot-settings/useBotSettingsDerived.ts",
    "src/state/bot-patch-queue.ts",
  ])
    await change(file, '    | "name"', '    | "j1ProjectId"\n    | "name"');
  await change(
    "src/components/BotSettingsDialog.tsx",
    'import { IdentitySection } from "./bot-settings/IdentitySection";',
    'import { IdentitySection } from "./bot-settings/IdentitySection";\nimport { J1ProjectBinding } from "./J1ProjectBinding";',
  );
  await change(
    "src/components/BotSettingsDialog.tsx",
    'import { J1ProjectBinding } from "./J1ProjectBinding";',
    'import { J1ProjectBinding } from "./J1ProjectBinding";\nimport { J1EngineeringTeam } from "./J1EngineeringTeam";',
  );
  await change(
    "src/components/BotSettingsDialog.tsx",
    "          <IdentitySection\n            bot={bot}",
    "          <>\n          <J1EngineeringTeam bot={bot} />\n          <J1ProjectBinding bot={bot} />\n          <IdentitySection\n            bot={bot}",
  );
  await change(
    "src/components/BotSettingsDialog.tsx",
    "            mascotMotion={derived.mascotMotion}\n          />",
    "            mascotMotion={derived.mascotMotion}\n          />\n          </>",
  );
}
