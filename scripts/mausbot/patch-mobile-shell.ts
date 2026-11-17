import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Applies after the shared J1 bridge, to the same disposable pinned assembly. */
export async function patchMobileShell(stage: string, root: string) {
  const change = async (file: string, before: string, after: string) => {
    const path = NodePath.join(stage, file);
    const source = (await NodeFSP.readFile(path, "utf8")).replaceAll("\r\n", "\n");
    if (source.split(before).length !== 2) throw new Error(`Pinned mobile shell changed: ${file}`);
    await NodeFSP.writeFile(path, source.replace(before, after));
  };
  await change(
    "server/index.ts",
    "j1DesktopCapabilities({ platform: process.platform, env: process.env, packaged: true, localConnection: j1ComputerDescriptor })",
    "j1DesktopCapabilities({ platform: process.platform, env: process.env, packaged: true, frame: false, localConnection: j1ComputerDescriptor })",
  );
  await change(
    "src/App.tsx",
    "  const framed = windowFramed(capabilities);",
    "  const framed = !j1Navigation && windowFramed(capabilities);",
  );
  await change(
    "src/App.tsx",
    "      <WindowFrameBar notifications={notificationTray} />",
    "      {!j1Navigation && <WindowFrameBar notifications={notificationTray} />}",
  );
  await NodeFSP.copyFile(
    NodePath.join(root, "scripts/mausbot/J1SettingsPicker.tsx"),
    NodePath.join(stage, "src/components/J1SettingsPicker.tsx"),
  );
  await change(
    "src/components/SettingsModal.tsx",
    'import { Select } from "./Select";',
    'import { Select } from "./Select";\nimport { J1SettingsPicker } from "./J1SettingsPicker";',
  );
  const settingsPath = NodePath.join(stage, "src/components/SettingsModal.tsx");
  const settings = await NodeFSP.readFile(settingsPath, "utf8");
  const selector = settings.match(
    /            <Select className="min-w-0 sm:hidden"\s+aria-label=\{t\("settings.title"\)\}\s+value=\{j1Path[\s\S]*?            <\/Select>/,
  )?.[0];
  if (!selector) throw new Error("Pinned settings section picker changed.");
  await change(
    "src/components/SettingsModal.tsx",
    selector,
    selector
      .replace("<Select", "<J1SettingsPicker")
      .replace("</Select>", "</J1SettingsPicker>")
      .replace("onChange={(event)", "onSelect={(value)")
      .replaceAll("event.target.value", "value"),
  );

  const barPath = NodePath.join(stage, "src/components/SidebarPhoneBar.tsx");
  const bar = await NodeFSP.readFile(barPath, "utf8");
  const tools = bar.match(/        <SidebarPopoverMenu[\s\S]*?        \/>/)?.[0];
  if (!tools) throw new Error("Pinned phone tools changed.");
  await change(
    "src/components/SidebarPhoneBar.tsx",
    "export function SidebarPhoneBar({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {",
    "export function SidebarPhoneBar({ query, onQuery, compact = false }: { query: string; onQuery: (query: string) => void; compact?: boolean }) {",
  );
  await change(
    "src/components/SidebarPhoneBar.tsx",
    "  return (\n    <div data-sidebar-phone-bar",
    `  if (compact) return (${tools.replace("size-11", "size-10")});\n  return (\n    <div data-sidebar-phone-bar`,
  );
  await change(
    "src/components/Sidebar.tsx",
    '<div className={cn("shrink-0", j1Navigation && "ml-10")} style={windowNoDragStyle}><SidebarProfileMenu iconOnly circle /></div>',
    '<div className={cn("flex shrink-0 items-center gap-2", j1Navigation && "ml-10")} style={windowNoDragStyle}><SidebarProfileMenu iconOnly circle />{j1Navigation && <SidebarPhoneBar query={query} onQuery={setQuery} compact />}</div>',
  );
  await change(
    "src/components/Sidebar.tsx",
    "phone ? <SidebarPhoneBar query={query} onQuery={setQuery} />",
    "phone ? !j1Navigation && <SidebarPhoneBar query={query} onQuery={setQuery} />",
  );
  await NodeFSP.appendFile(
    NodePath.join(stage, "src/styles.css"),
    `
/* The managed workspace occupies one viewport; the native container owns device insets. */
html[data-j1-view], html[data-j1-view] body, html[data-j1-view] #root { height:100%; min-height:0; overflow:hidden; }
html[data-j1-desktop="win32"] [data-chathead-row] { padding-right:142px; }
@media (max-width:767.98px) {
  html[data-j1-view] .glass-popup-frame[data-settings-sheet] { padding:0; }
  html[data-j1-view] .glass-popup-frame[data-settings-sheet] > .glass-popup { border-radius:0; border:0; }
}
`,
  );
}
