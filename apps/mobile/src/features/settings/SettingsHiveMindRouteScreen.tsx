import { updateHiveMindConfig } from "@t3tools/contracts";
import { formatHiveSkillRoots, parseHiveSkillRoots } from "@t3tools/client-runtime/state/hive-mind";
import type { StaticScreenProps } from "@react-navigation/native";
import type { HiveMindConfig, HiveMindMemory, HiveMindSnapshot } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { hiveMind } from "../../state/hiveMind";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { EnvironmentId } from "@t3tools/contracts";

export function SettingsHiveMindRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return (
    <HiveMindEnvironment
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}
function HiveMindEnvironment({ environmentId }: { environmentId: EnvironmentId }) {
  const read = useAtomCommand(hiveMind.snapshot, { reportFailure: false });
  const configure = useAtomCommand(hiveMind.configure, { reportFailure: false });
  const search = useAtomCommand(hiveMind.search, { reportFailure: false });
  const mutate = useAtomCommand(hiveMind.mutate, { reportFailure: false });
  const synchronize = useAtomCommand(hiveMind.synchronize, { reportFailure: false });
  const importKnowledge = useAtomCommand(hiveMind.importKnowledge, { reportFailure: false });
  const [sourceUrl, setSourceUrl] = useState("http://127.0.0.1:8888");
  const [sourceBank, setSourceBank] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [state, setState] = useState<HiveMindSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<ReadonlyArray<HiveMindMemory>>([]);
  const [editing, setEditing] = useState<HiveMindMemory>();
  const [subject, setSubject] = useState("");
  const [fact, setFact] = useState("");
  const [project, setProject] = useState("");
  const [setup, setSetup] = useState<HiveMindConfig>({ version: 1 });
  const [skillFolders, setSkillFolders] = useState("");
  const initialized = useRef(false);
  const refresh = useCallback(async () => {
    const result = await read({ environmentId, input: {} });
    if (result._tag === "Success") {
      setState(result.value);
      if (!initialized.current) {
        initialized.current = true;
        setSetup(result.value.config);
        setSkillFolders(formatHiveSkillRoots(result.value.config.skills));
      }
    } else setError(String(squashAtomCommandFailure(result)));
  }, [environmentId, read]);
  useEffect(() => {
    // Hydrate the selected environment after the external RPC completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(() => {
      if (!busyRef.current) void refresh();
    }, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function find() {
    const result = await search({
      environmentId,
      input: { query, ...(project.trim() ? { project: project.trim() } : {}) },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    setMemories(result.value.memories);
    if (result.value.retrieval.status === "degraded") setError(result.value.retrieval.message);
  }
  return (
    <SettingsScreen title="Hive Mind">
      <ScreenScrollView>
        <View className="gap-5 p-4">
          {error && (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </Text>
          )}
          <SettingsSection title="Hive Mind">
            <View className="gap-2 p-4">
              <Text>
                {state
                  ? `${state.records} records · ${state.skills} skills · ${state.phase}`
                  : "Loading Hive Mind…"}
              </Text>
              {state && <Text>{state.pendingIndex} awaiting retrieval</Text>}
              {state?.issues.map((issue) => (
                <Text key={issue} selectable>
                  {issue}
                </Text>
              ))}
            </View>
            <SettingsActionRow
              icon="brain"
              label="Synchronize now"
              disabled={busy || state?.phase === "syncing"}
              onPress={() =>
                void run(async () => {
                  const result = await synchronize({ environmentId, input: {} });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  setState(result.value);
                })
              }
            />
          </SettingsSection>
          <SettingsSection title="Setup">
            <View className="gap-2 p-4">
              <Text>
                Paths belong to this environment. Use its Hive Mind vault, or enter an existing
                vault and skills folders in the setup below.
              </Text>
              <Text>Obsidian-compatible vault</Text>
              <TextInput
                accessibilityLabel="Vault folder"
                placeholder={state?.defaultVault}
                value={setup.vault ?? ""}
                onChangeText={(vault) =>
                  setSetup(updateHiveMindConfig(setup, "vault", vault || undefined))
                }
                className="rounded-lg border border-border p-3 text-foreground"
              />
              <Text>Semantic retrieval URL</Text>
              <TextInput
                accessibilityLabel="Retrieval URL"
                placeholder="http://127.0.0.1:8888"
                autoCapitalize="none"
                value={setup.hindsight?.url ?? ""}
                onChangeText={(url) =>
                  setSetup(
                    updateHiveMindConfig(
                      setup,
                      "hindsight",
                      url
                        ? {
                            url,
                            bank: setup.hindsight?.bank ?? state?.defaultBank ?? "j1-hive",
                            timeoutMs: 60_000,
                          }
                        : undefined,
                    ),
                  )
                }
                className="rounded-lg border border-border p-3 text-foreground"
              />
              {setup.hindsight && (
                <>
                  <Text>Retrieval bank</Text>
                  <TextInput
                    accessibilityLabel="Retrieval bank"
                    autoCapitalize="none"
                    value={setup.hindsight.bank}
                    onChangeText={(bank) =>
                      setSetup({ ...setup, hindsight: { ...setup.hindsight!, bank } })
                    }
                    className="rounded-lg border border-border p-3 text-foreground"
                  />
                </>
              )}
              <Text>
                Skills folders, one absolute path per line; append | project to restrict a folder
              </Text>
              <TextInput
                accessibilityLabel="Skills folders"
                multiline
                value={skillFolders}
                onChangeText={setSkillFolders}
                className="min-h-24 rounded-lg border border-border p-3 text-foreground"
              />
              <Text>Installed local engine folder, optional</Text>
              <TextInput
                accessibilityLabel="Local engine folder"
                placeholder="Existing Hindsight installation"
                value={setup.localEngine?.directory ?? ""}
                onChangeText={(directory) =>
                  setSetup(
                    updateHiveMindConfig(
                      setup,
                      "localEngine",
                      directory ? { ...setup.localEngine, directory } : undefined,
                    ),
                  )
                }
                className="rounded-lg border border-border p-3 text-foreground"
              />
              <Text>
                Hive Mind can restore the installed local engine and Ollama when they are offline,
                preserving their configuration.
              </Text>
            </View>
            <SettingsSwitchRow
              icon="arrow.clockwise"
              label="Automatic synchronization"
              value={setup.automatic !== false}
              onValueChange={(automatic) => setSetup({ ...setup, automatic })}
            />
            <SettingsActionRow
              icon="folder"
              label="Use Hive Mind vault"
              disabled={busy || !state}
              onPress={() => {
                if (state) setSetup({ ...setup, vault: state.defaultVault });
              }}
            />
            <SettingsActionRow
              icon="brain"
              label="Save setup"
              disabled={busy || !state}
              onPress={() =>
                void run(async () => {
                  const result = await configure({
                    environmentId,
                    input: { ...setup, skills: parseHiveSkillRoots(skillFolders) },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  setState(result.value);
                  setSetup(result.value.config);
                })
              }
            />
          </SettingsSection>
          <SettingsSection title="Memory and skills">
            <View className="gap-3 p-4">
              <TextInput
                accessibilityLabel="Search Hive Mind"
                placeholder="Search memories and skills"
                value={query}
                onChangeText={setQuery}
                className="rounded-lg border border-border p-3 text-foreground"
              />
            </View>
            <SettingsActionRow
              icon="brain"
              label="Search"
              disabled={busy}
              onPress={() => void run(find)}
            />
            {memories.map((memory) => (
              <View key={memory.id} className="gap-2 border-t border-border p-4">
                <Text className="font-semibold">{memory.subject}</Text>
                <Text selectable>{memory.fact}</Text>
                <Text>
                  {memory.project ?? "General"} · {memory.kind ?? "memory"}
                </Text>
                <Text selectable>{memory.sourcePath ?? memory.sourceThreadId}</Text>
                {memory.kind !== "skill" && (
                  <SettingsActionRow
                    icon="brain"
                    label="Edit"
                    disabled={busy}
                    onPress={() => {
                      setEditing(memory);
                      setSubject(memory.subject);
                      setFact(memory.fact);
                      setProject(memory.project ?? "");
                    }}
                  />
                )}
                <SettingsActionRow
                  icon="brain"
                  label="Forget"
                  disabled={busy}
                  onPress={() =>
                    Alert.alert("Forget memory?", memory.subject, [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Forget",
                        style: "destructive",
                        onPress: () =>
                          void run(async () => {
                            const result = await mutate({
                              environmentId,
                              input: { action: "forget", id: memory.id },
                            });
                            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                            await find();
                            await refresh();
                          }),
                      },
                    ])
                  }
                />
              </View>
            ))}
          </SettingsSection>
          <SettingsSection title={editing ? "Edit memory" : "Add memory"}>
            <View className="gap-3 p-4">
              <TextInput
                accessibilityLabel="Memory subject"
                placeholder="Subject"
                value={subject}
                onChangeText={setSubject}
                editable={!editing}
                maxLength={160}
                className="rounded-lg border border-border p-3 text-foreground"
              />
              <TextInput
                accessibilityLabel="Memory project"
                placeholder="Project, or empty for general memory"
                value={project}
                onChangeText={setProject}
                editable={!editing}
                maxLength={160}
                className="rounded-lg border border-border p-3 text-foreground"
              />
              <TextInput
                accessibilityLabel="Memory fact"
                placeholder="Fact or decision"
                value={fact}
                onChangeText={setFact}
                multiline
                maxLength={2_000}
                className="min-h-24 rounded-lg border border-border p-3 text-foreground"
              />
            </View>
            <SettingsActionRow
              icon="brain"
              label="Save memory"
              disabled={busy || !subject.trim() || !fact.trim()}
              onPress={() =>
                void run(async () => {
                  const input = editing
                    ? {
                        action: "edit" as const,
                        id: editing.id,
                        revision: editing.revision ?? "",
                        fact,
                      }
                    : {
                        action: "remember" as const,
                        scope: project.trim() ? ("project" as const) : ("general" as const),
                        ...(project.trim() ? { project: project.trim() } : {}),
                        subject,
                        fact,
                      };
                  const result = await mutate({ environmentId, input });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  setState(result.value);
                  setEditing(undefined);
                  setSubject("");
                  setFact("");
                  await find();
                })
              }
            />
            {editing && (
              <SettingsActionRow
                icon="brain"
                label="Cancel edit"
                onPress={() => {
                  setEditing(undefined);
                  setSubject("");
                  setFact("");
                }}
              />
            )}
          </SettingsSection>
          <SettingsSection title="Existing knowledge">
            <View className="gap-3 p-4">
              <Text>
                Import original documents from an existing Hindsight bank. The source stays
                unchanged; excerpts are available through explicit search.
              </Text>
              <TextInput
                accessibilityLabel="Source retrieval URL"
                autoCapitalize="none"
                value={sourceUrl}
                onChangeText={setSourceUrl}
                className="rounded-lg border border-border p-3 text-foreground"
              />
              <TextInput
                accessibilityLabel="Source knowledge bank"
                autoCapitalize="none"
                placeholder="Existing knowledge bank"
                value={sourceBank}
                onChangeText={setSourceBank}
                className="rounded-lg border border-border p-3 text-foreground"
              />
              {importNotice && <Text>{importNotice}</Text>}
            </View>
            <SettingsActionRow
              icon="arrow.down"
              label="Import existing knowledge"
              disabled={busy || !sourceBank.trim()}
              onPress={() =>
                void run(async () => {
                  const result = await importKnowledge({
                    environmentId,
                    input: { url: sourceUrl, bank: sourceBank },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  const report = result.value;
                  setImportNotice(
                    `${report.documents} documents: ${report.created} added, ${report.updated} updated, ${report.unchanged} unchanged, ${report.protected} corrections preserved. ${report.issues.join(" ")}`,
                  );
                  await refresh();
                })
              }
            />
          </SettingsSection>
        </View>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
