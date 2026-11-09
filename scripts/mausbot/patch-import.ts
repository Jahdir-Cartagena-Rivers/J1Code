import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** Extend the pinned app's existing import and restore flow rather than copying live profile databases. */
export async function patchOpenMausImport(stage: string) {
  const change = async (file: string, before: string, after: string) => {
    const path = NodePath.join(stage, file);
    const source = (await NodeFSP.readFile(path, "utf8")).replaceAll("\r\n", "\n");
    if (source.split(before).length !== 2) throw new Error(`Pinned import source changed: ${file}`);
    await NodeFSP.writeFile(path, source.replace(before, after));
  };
  await NodeFSP.mkdir(NodePath.join(stage, "server/j1"), { recursive: true });
  for (const [from, to] of [
    ["backup-compatibility.ts", "backup-compatibility.ts"],
    ["backup-compatibility.test.ts.txt", "backup-compatibility.test.ts"],
  ])
    await NodeFSP.copyFile(
      NodeURL.fileURLToPath(new URL(from, import.meta.url)),
      NodePath.join(stage, "server/j1", to),
    );
  await change(
    "server/workspace-backup-http.ts",
    "import { randomUUID }",
    'import { OPENMAUS_BACKUP_COMPATIBILITY_VERSION } from "./j1/backup-compatibility.ts";\nimport { randomUUID }',
  );
  await change(
    "server/workspace-backup-http.ts",
    "currentAppVersion: options.appVersion",
    "currentAppVersion: OPENMAUS_BACKUP_COMPATIBILITY_VERSION",
  );
  await NodeFSP.copyFile(
    NodeURL.fileURLToPath(new URL("./OpenMausImportDialog.tsx", import.meta.url)),
    NodePath.join(stage, "src/components/OpenMausImportDialog.tsx"),
  );
  await NodeFSP.copyFile(
    NodeURL.fileURLToPath(new URL("./openmaus-import.test.ts.txt", import.meta.url)),
    NodePath.join(stage, "src/components/openmaus-import.test.ts"),
  );
  await change(
    "src/components/WorkspaceBackupSettings.tsx",
    "export function WorkspaceBackupSettings() {",
    "export function WorkspaceBackupSettings({ importOnly = false }: { importOnly?: boolean } = {}) {",
  );
  await change(
    "src/components/WorkspaceBackupSettings.tsx",
    '<Card title={t("backup.export")} subtitle={t("backup.passwordHint")}>',
    '{!importOnly && <Card title={t("backup.export")} subtitle={t("backup.passwordHint")}>',
  );
  await change(
    "src/components/WorkspaceBackupSettings.tsx",
    '</Card>\n            <Card title={t("backup.import")}',
    '</Card>}\n            <Card title={t("backup.import")}',
  );
  await change(
    "src/components/ImportSettings.tsx",
    "import { GrokBotMark }",
    'import { OpenMausImportDialog } from "./OpenMausImportDialog";\nimport { GrokBotMark }',
  );
  await change(
    "src/components/ImportSettings.tsx",
    "      <GrokImportSection />",
    "      <OpenMausImportSection />\n      <GrokImportSection />",
  );
  const settings = NodePath.join(stage, "src/components/ImportSettings.tsx");
  await NodeFSP.appendFile(
    settings,
    `
export function OpenMausImportSection() {
  const [open, setOpen] = useState(false);
  return <section data-import-section="openmaus" className="rounded-xl bg-card p-4">
    <div className="text-[15px] font-medium text-ink">Import from OpenMaus</div>
    <p className="mt-1 text-[13px] text-ink-secondary">Bring your bots, conversation history, memories, routines, and files from an OpenMaus workspace backup.</p>
    <button type="button" onClick={() => setOpen(true)} className={cn(buttonClass, "mt-3")}>Import from OpenMaus</button>
    {open && <OpenMausImportDialog onClose={() => setOpen(false)} />}
  </section>;
}
`,
  );
  await change(
    "src/components/GrokMovePopup.tsx",
    '"start" | "not_now" | "close"',
    '"start" | "openmaus" | "not_now" | "close"',
  );
  await change(
    "src/components/GrokMovePopup.tsx",
    '{t("settings.import.grokTitle")}</h2>',
    "Bring your bots to J1 Code</h2>",
  );
  await change(
    "src/components/GrokMovePopup.tsx",
    '{t("grokMove.popup.body")}</p>',
    "Import your OpenMaus workspace or bring your bots from Grok. You can also do this later in Settings → Import.</p>",
  );
  await change(
    "src/components/GrokMovePopup.tsx",
    '{t("grokMove.popup.start")}</button>',
    "Import from Grok</button>",
  );
  await change(
    "src/components/GrokMovePopup.tsx",
    '<div className="mt-1"><NotNowButton',
    '<button type="button" onClick={() => onDone("openmaus")} className={cn(PRIMARY_BUTTON, "mt-2 w-full")}>Import from OpenMaus</button>\n        <div className="mt-1"><NotNowButton',
  );
  await change(
    "src/components/AppNotices.tsx",
    "import { GrokMovePopup,",
    'import { OpenMausImportDialog } from "./OpenMausImportDialog";\nimport { GrokMovePopup,',
  );
  await change(
    "src/components/AppNotices.tsx",
    "  const [grokOpen, setGrokOpen] = useState(false);",
    "  const [openMausImport, setOpenMausImport] = useState(false);\n  const [grokOpen, setGrokOpen] = useState(false);",
  );
  await change(
    "src/components/AppNotices.tsx",
    "  if (grokOpen) return",
    "  if (openMausImport) return <OpenMausImportDialog onClose={() => setOpenMausImport(false)} />;\n  if (grokOpen) return",
  );
  await change(
    "src/components/AppNotices.tsx",
    '      if (action === "start") setGrokOpen(true);',
    '      if (action === "start") setGrokOpen(true);\n      if (action === "openmaus") setOpenMausImport(true);',
  );
  await change(
    "src/components/AppNotices.tsx",
    '&& launchDialogShown() !== "mausbot" && !noticeSeen(record, GROK_MOVE_NOTICE)',
    '&& (state.config?.j1Managed === true || launchDialogShown() !== "mausbot") && !noticeSeen(record, GROK_MOVE_NOTICE)',
  );
  // Keep the existing keyboard and Grok action regressions aligned with the two-source chooser.
  await change(
    "src/components/GrokMovePopup.test.ts",
    '.toBe("Move from Grok Bot")',
    '.toBe("Bring your bots to J1 Code")',
  );
  const popupTest = NodePath.join(stage, "src/components/GrokMovePopup.test.ts");
  let tests = await NodeFSP.readFile(popupTest, "utf8");
  tests = tests.replaceAll("Let's start", "Import from Grok");
  tests = tests.replace(
    '["Import from Grok", "Not now", "Close"]',
    '["Import from Grok", "Import from OpenMaus", "Not now", "Close"]',
  );
  tests = tests.replace(
    '[["Import from Grok", "start"],',
    '[["Import from Grok", "start"], ["Import from OpenMaus", "openmaus"],',
  );
  tests = tests.replace('toBe(button("Not now"))', 'toBe(button("Import from OpenMaus"))');
  await NodeFSP.writeFile(popupTest, tests);
  const noticeTests = NodePath.join(stage, "src/components/AppNotices.test.ts");
  await NodeFSP.writeFile(
    noticeTests,
    (await NodeFSP.readFile(noticeTests, "utf8"))
      .replaceAll('TITLE = "Move from Grok Bot"', 'TITLE = "Bring your bots to J1 Code"')
      .replaceAll(
        "Bring your Bots here, with their skills, routines and memories.",
        "Import your OpenMaus workspace or bring your bots from Grok.",
      )
      .replaceAll("Let&#x27;s start", "Import from Grok"),
  );
  const backupTests = NodePath.join(stage, "src/components/WorkspaceBackupSettings.test.ts");
  // The managed runtime deliberately exits without its owning parent's IPC channel.
  for (const file of ["scripts/control-omb.ts", "scripts/verify-workspace-backup.ts"])
    await change(file, 'stdio: ["ignore", log, log]', 'stdio: ["ignore", log, log, "ipc"]');
  await NodeFSP.writeFile(
    backupTests,
    (await NodeFSP.readFile(backupTests, "utf8")).replaceAll("MausBot", "J1 Code"),
  );
}
