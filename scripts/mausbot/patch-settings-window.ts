type Change = (file: string, before: string, after: string) => Promise<void>;

/** Connect the v0.1.182 settings window to the host portal and navigation. */
export async function patchSettingsWindow(change: Change) {
  const windowFile = "src/components/settings/SettingsWindow.tsx";
  await change(
    windowFile,
    "export function SettingsWindow() {",
    `import { J1SettingsSlot, j1ActiveElement, j1Focusable, j1OpenSettings, j1SettingsPopupOpen, j1SettingsSection } from "../J1Settings";
import { j1SettingsClosed, useJ1Navigation } from "../J1Navigation";

export function SettingsWindow() {`,
  );
  await change(
    windowFile,
    "  const ctx = useSettingsContext();",
    `  const navigation = useJ1Navigation();
  const j1Path = navigation?.active.startsWith("/settings/") ? navigation.active : null;
  const nativeSection = j1Path ? j1SettingsSection(j1Path) : undefined;
  const ctx = useSettingsContext();`,
  );
  await change(
    windowFile,
    `const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';\n`,
    "",
  );
  await change(
    windowFile,
    '  useEffect(() => { setAnchor(target.anchor ?? null); setNarrowPage((open) => open || section !== "overview"); }, [section, target.anchor]);',
    '  useEffect(() => { setAnchor(target.anchor ?? null); setNarrowPage((open) => open || j1Path !== null || section !== "overview"); }, [section, target.anchor, j1Path]);',
  );
  await change(
    windowFile,
    '  const close = () => dispatch({ type: "toggleAppSettings", open: false });',
    '  const close = () => { j1SettingsClosed(); dispatch({ type: "toggleAppSettings", open: false }); };',
  );
  await change(
    windowFile,
    '    dispatch({ type: "toggleAppSettings", open: true, section: next });',
    `    if (navigation) {
      const section = next === "ai" ? "engines" : next === "devices" ? "companion"
        : next === "desktops" ? "computer" : next === "transfer" ? "backups" : next;
      if (j1OpenSettings(section)) return;
    }
    dispatch({ type: "toggleAppSettings", open: true, section: next });`,
  );
  await change(
    windowFile,
    '      if (event.key === "Escape") { event.preventDefault(); close(); return; }',
    '      if (event.key === "Escape") { if (j1SettingsPopupOpen(dialog)) return; event.preventDefault(); close(); return; }',
  );
  await change(
    windowFile,
    "      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.checkVisibility());",
    `      const focusable = j1Focusable(dialog);
      const active = j1ActiveElement();
      const root = active?.getRootNode();`,
  );
  await change(
    windowFile,
    `      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }`,
    `      if (event.shiftKey && (active === first || !dialog.contains(root instanceof ShadowRoot ? root.host : active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }`,
  );
  await change(
    windowFile,
    '<div ref={scrollRef} data-settings-scroll data-settings-content=""',
    '<div ref={scrollRef} data-settings-scroll data-j1-settings-scroll data-settings-content=""',
  );
  await change(
    windowFile,
    "current={narrow ? null : target.page}",
    "current={narrow || (j1Path && !nativeSection) ? null : target.page}",
  );
  await change(
    windowFile,
    `                        <LicenseExpiryBanner config={config} />
                        {page.owner === "place" && config === null`,
    `                        {!navigation && <LicenseExpiryBanner config={config} />}
                        {j1Path && (j1Path !== "/settings/providers" || !navigation?.providers) && <J1SettingsSlot />}
                        {(!j1Path || (nativeSection && nativeSection !== "companion" && nativeSection !== "general")) && (page.owner === "place" && config === null`,
  );
  await change(
    windowFile,
    "                          : <SettingsPageBody page={target.page} />}",
    "                          : <SettingsPageBody page={target.page} />)}",
  );

  const navFile = "src/components/settings/SettingsNav.tsx";
  await change(
    navFile,
    "export function SettingsNav(",
    `import { J1SettingsLinks } from "../J1Settings";
import { useJ1Navigation } from "../J1Navigation";

const hostSettingsGroups = { app: ["you"], place: ["computers", "ai"], account: ["account"] } as const;

export function SettingsNav(`,
  );
  await change(
    navFile,
    "badge: <AppIcon size={24} />",
    'badge: j1Navigation ? <span aria-hidden className="flex size-6 items-center justify-center rounded-md bg-ink/[0.1] text-[10px] font-bold text-ink">J1</span> : <AppIcon size={24} />',
  );
  await change(
    navFile,
    '  const searching = query.trim() !== "";',
    '  const searching = query.trim() !== "";\n  const j1Navigation = useJ1Navigation();',
  );
  await change(
    navFile,
    "                ))}\n              </div>",
    "                ))}\n                {j1Navigation && hostSettingsGroups[owner].map((group) => <J1SettingsLinks key={group} query={query} group={group} />)}\n              </div>",
  );
  await change(
    navFile,
    "        })}\n      </div>\n      {!SIMPLE_ONLY && <AdvancedModeFooter narrow={narrow} onChange={onAdvanced} />}",
    "        })}\n        {j1Navigation && searching && Object.values(hostSettingsGroups).flat().map((group) => <J1SettingsLinks key={group} query={query} group={group} />)}\n      </div>\n      {!j1Navigation && !SIMPLE_ONLY && <AdvancedModeFooter narrow={narrow} onChange={onAdvanced} />}",
  );
}

export async function patchLegacySettingsWindow(change: Change) {
  await change(
    "src/components/SettingsModal.tsx",
    'import { t } from "@/lib/i18n";',
    'import { t } from "@/lib/i18n";\nimport { J1SettingsLinks, J1SettingsSlot, j1SettingsSection, j1SettingsPath, j1SettingsLabel, j1OpenSettings, j1ExtraPages, j1Focusable, j1ActiveElement, j1SettingsPopupOpen } from "./J1Settings";\nimport { useJ1Navigation, j1Post, j1SettingsClosed } from "./J1Navigation";',
  );
  // Managed settings share one readable navigation rail. Labels must be allowed
  // to wrap without overlapping the next fixed-height row.
  await change(
    "src/components/SettingsModal.tsx",
    "w-[200px] shrink-0 flex-col gap-1",
    "w-[224px] shrink-0 flex-col gap-1",
  );
  await change(
    "src/components/SettingsModal.tsx",
    '                      "flex h-8 shrink-0 cursor-pointer items-center gap-[9px] rounded-lg px-[9px] text-left text-[13px]',
    '                      "flex min-h-9 shrink-0 cursor-pointer items-center gap-[9px] rounded-lg px-[9px] py-1.5 text-left text-[13px] leading-5',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "  const advanced = useAdvancedMode();",
    '  const preferredAdvanced = useAdvancedMode();\n  const j1Navigation = useJ1Navigation();\n  const advanced = preferredAdvanced || Boolean(j1Navigation);\n  const j1Path = j1Navigation?.active.startsWith("/settings/") ? j1Navigation.active : null;\n  const j1Label = j1Navigation?.settingsPages?.find((page) => page.path === j1Path)?.label;',
  );
  await change(
    "src/components/SettingsModal.tsx",
    "  const visibleSections = availableSections.filter((entry) => sectionMatches(entry, q));",
    '  const [j1MoreSettings, setJ1MoreSettings] = useState(false);\n  const secondarySections = new Set<AppSettingsSection>(["decisionModel", "imageGeneration", "import", "people", "experimental"]);\n  const visibleSections = availableSections.filter((entry) => (sectionMatches(entry, q) || Boolean(j1Navigation && j1SettingsLabel(entry.id, "").toLowerCase().includes(q))) && (!j1Navigation || j1MoreSettings || q !== "" || entry.id === section || !secondarySections.has(entry.id)));',
  );
  await change(
    "src/components/SettingsModal.tsx",
    '          {keyResultButtons("cursor-pointer flex min-h-9',
    '          {j1Navigation && !q && <button type="button" aria-expanded={j1MoreSettings} onClick={() => setJ1MoreSettings((value) => !value)} className="min-h-9 rounded-lg px-[9px] py-1.5 text-left text-[13px] text-ink-secondary hover:bg-ink/[0.06]">{j1MoreSettings ? "Fewer settings" : "More settings"}</button>}\n          {keyResultButtons("cursor-pointer flex min-h-9',
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
    '  const openSection = (id: AppSettingsSection) => { if (j1Navigation && j1OpenSettings(id)) return; dispatch({ type: "toggleAppSettings", open: true, section: id }); };',
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
    '            {(j1Path === "/settings/appearance" || j1Path === "/settings/integrations") && <J1SettingsSlot />}\n            {(!j1Path || Boolean(j1SettingsSection(j1Path))) && !(j1Navigation && section === "companion") && <><LicenseExpiryBanner config={state.config} />{renderSection(section)}</>}\n            {j1Path === "/settings/keybindings" && <><TalkShortcutRow /><SendKeyRow /></>}\n            {j1Path && j1Path !== "/settings/appearance" && j1Path !== "/settings/integrations" && !(j1Path === "/settings/providers" && j1Navigation?.providers) && <J1SettingsSlot />}',
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
}
