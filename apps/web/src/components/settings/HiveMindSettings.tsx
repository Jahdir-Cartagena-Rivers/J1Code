import { updateHiveMindConfig } from "@t3tools/contracts";
import { formatHiveSkillRoots, parseHiveSkillRoots } from "@t3tools/client-runtime/state/hive-mind";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  HiveMindConfig,
  HiveMindMemory,
  HiveMindMutation,
  HiveMindSnapshot,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { hiveMind } from "../../state/hiveMind";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function HiveMindSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment ? (
        <HiveMindEnvironment
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p>Select a connected environment to manage its Hive Mind.</p>
      )}
    </SettingsPageContainer>
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
  const [snapshot, setSnapshot] = useState<HiveMindSnapshot>();
  const [config, setConfig] = useState<HiveMindConfig>();
  const [skillFolders, setSkillFolders] = useState("");
  const initialized = useRef(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<ReadonlyArray<HiveMindMemory>>([]);
  const [editing, setEditing] = useState<HiveMindMemory>();
  const [subject, setSubject] = useState("");
  const [fact, setFact] = useState("");
  const [project, setProject] = useState("");
  const [retrieval, setRetrieval] = useState("");
  const refresh = useCallback(async () => {
    const result = await read({ environmentId, input: {} });
    if (result._tag === "Success") {
      setSnapshot(result.value);
      if (!initialized.current) {
        setConfig(result.value.config);
        setSkillFolders(formatHiveSkillRoots(result.value.config.skills));
        initialized.current = true;
      }
    } else setError(String(squashAtomCommandFailure(result)));
  }, [environmentId, read]);
  useEffect(() => {
    // Hydrate and refresh the external environment snapshot after its RPC completes.
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
    setRetrieval(result.value.retrieval.message ?? result.value.retrieval.status);
  }
  async function save(input: HiveMindMutation) {
    const result = await mutate({ environmentId, input });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    setSnapshot(result.value);
    setEditing(undefined);
    setSubject("");
    setFact("");
    await find();
  }
  if (!snapshot || !config) return <p role="status">{error ?? "Loading Hive Mind…"}</p>;
  return (
    <div className="space-y-6">
      <SettingsSection title="Hive Mind" id="hive-mind-status">
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            One memory system for your agents, editable knowledge vault, and reusable skills. Paths
            belong to this server environment.
          </p>
          <p role="status">
            {snapshot.records} records · {snapshot.skills} skills · {snapshot.pendingIndex} awaiting
            retrieval · {snapshot.phase}
          </p>
          {snapshot.lastSync && (
            <p className="text-xs text-muted-foreground">
              Last sync: {new Date(snapshot.lastSync).toLocaleString()}
            </p>
          )}
          {snapshot.issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {snapshot.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <Button
            disabled={busy || snapshot.phase === "syncing"}
            variant="outline"
            onClick={() =>
              void run(async () => {
                const result = await synchronize({ environmentId, input: {} });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                setSnapshot(result.value);
              })
            }
          >
            Synchronize now
          </Button>
        </div>
      </SettingsSection>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <SettingsSection title="Setup" id="hive-mind-setup">
        <form
          className="space-y-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const result = await configure({
                environmentId,
                input: { ...config, skills: parseHiveSkillRoots(skillFolders) },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              setSnapshot(result.value);
              setConfig(result.value.config);
            });
          }}
        >
          <label className="block space-y-1 text-sm">
            Obsidian-compatible vault
            <Input
              placeholder={snapshot.defaultVault}
              aria-label="Vault folder"
              value={config.vault ?? ""}
              onChange={(event) =>
                setConfig(updateHiveMindConfig(config, "vault", event.target.value || undefined))
              }
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfig({ ...config, vault: snapshot.defaultVault })}
          >
            Use Hive Mind vault
          </Button>
          <label className="block space-y-1 text-sm">
            Semantic retrieval URL
            <Input
              placeholder="http://127.0.0.1:8888"
              aria-label="Retrieval URL"
              value={config.hindsight?.url ?? ""}
              onChange={(event) =>
                setConfig(
                  updateHiveMindConfig(
                    config,
                    "hindsight",
                    event.target.value
                      ? {
                          url: event.target.value,
                          bank: config.hindsight?.bank ?? snapshot.defaultBank,
                          timeoutMs: 60_000,
                        }
                      : undefined,
                  ),
                )
              }
            />
          </label>
          {config.hindsight && (
            <label className="block space-y-1 text-sm">
              Retrieval bank
              <Input
                value={config.hindsight.bank}
                aria-label="Retrieval bank"
                onChange={(event) =>
                  setConfig({
                    ...config,
                    hindsight: { ...config.hindsight!, bank: event.target.value },
                  })
                }
              />
            </label>
          )}
          <label className="block space-y-1 text-sm">
            Skills folders, one absolute path per line; append | project to restrict a folder
            <Textarea
              rows={3}
              aria-label="Skills folders"
              value={skillFolders}
              onChange={(event) => setSkillFolders(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            Installed local engine folder, optional
            <Input
              aria-label="Installed local engine folder"
              value={config.localEngine?.directory ?? ""}
              placeholder="Folder containing the existing Hindsight installation"
              onChange={(event) =>
                setConfig(
                  updateHiveMindConfig(
                    config,
                    "localEngine",
                    event.target.value
                      ? { ...config.localEngine, directory: event.target.value }
                      : undefined,
                  ),
                )
              }
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Hive Mind can restore this local engine and its installed Ollama service when they are
            offline. Existing configuration and shared services are preserved.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.automatic !== false}
              onChange={(event) => setConfig({ ...config, automatic: event.target.checked })}
            />
            Automatic synchronization
          </label>
          <Button type="submit" disabled={busy}>
            Save setup
          </Button>
        </form>
      </SettingsSection>
      <SettingsSection title="Memory and skills" id="hive-mind-memory">
        <div className="space-y-4 p-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(find);
            }}
          >
            <div className="flex-1">
              <Input
                aria-label="Search Hive Mind"
                placeholder="Search memories and skills"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy}>
              Search
            </Button>
          </form>
          {retrieval && <p className="text-xs text-muted-foreground">Retrieval: {retrieval}</p>}
          {memories.map((memory) => (
            <article key={memory.id} className="space-y-2 rounded-lg border p-3">
              <h3 className="font-medium">{memory.subject}</h3>
              <p className="whitespace-pre-wrap text-sm">{memory.fact}</p>
              <p className="break-all text-xs text-muted-foreground">
                {memory.project ?? "General"} · {memory.kind ?? "memory"} · Source:{" "}
                {memory.sourcePath ?? memory.sourceThreadId}
              </p>
              <div className="flex gap-2">
                {memory.kind !== "skill" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditing(memory);
                      setSubject(memory.subject);
                      setFact(memory.fact);
                      setProject(memory.project ?? "");
                    }}
                  >
                    Edit
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(`Forget “${memory.subject}”? The vault copy will be archived.`)
                    )
                      void run(() => save({ action: "forget", id: memory.id }));
                  }}
                >
                  Forget
                </Button>
              </div>
            </article>
          ))}
          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() =>
                save(
                  editing
                    ? { action: "edit", id: editing.id, revision: editing.revision ?? "", fact }
                    : {
                        action: "remember",
                        scope: project.trim() ? "project" : "general",
                        ...(project.trim() ? { project: project.trim() } : {}),
                        subject,
                        fact,
                      },
                ),
              );
            }}
          >
            <h3 className="font-medium">{editing ? "Edit memory" : "Add memory"}</h3>
            <Input
              aria-label="Memory subject"
              placeholder="Subject"
              value={subject}
              disabled={!!editing}
              maxLength={160}
              required
              onChange={(event) => setSubject(event.target.value)}
            />
            <Input
              aria-label="Memory project"
              placeholder="Project, or leave empty for general memory"
              value={project}
              disabled={!!editing}
              maxLength={160}
              onChange={(event) => setProject(event.target.value)}
            />
            <Textarea
              aria-label="Memory fact"
              placeholder="A fact, decision, or reusable explanation"
              value={fact}
              maxLength={2_000}
              required
              rows={5}
              onChange={(event) => setFact(event.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                Save memory
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditing(undefined);
                    setSubject("");
                    setFact("");
                  }}
                >
                  Cancel edit
                </Button>
              )}
            </div>
          </form>
        </div>
      </SettingsSection>
      <SettingsSection title="Existing knowledge" id="hive-mind-import">
        <form
          className="space-y-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const result = await importKnowledge({
                environmentId,
                input: { url: sourceUrl, bank: sourceBank },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              const report = result.value;
              setImportNotice(
                `${report.documents} original documents: ${report.created} added, ${report.updated} updated, ${report.unchanged} unchanged, ${report.protected} corrections preserved. ${report.issues.join(" ")}`,
              );
              await refresh();
            });
          }}
        >
          <p className="text-sm text-muted-foreground">
            Bring original documents from an existing Hindsight bank into Hive Mind. The source bank
            stays unchanged. Imported excerpts retain provenance and are available through explicit
            search.
          </p>
          <Input
            aria-label="Source retrieval URL"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            required
          />
          <Input
            aria-label="Source knowledge bank"
            placeholder="Existing knowledge bank"
            value={sourceBank}
            onChange={(event) => setSourceBank(event.target.value)}
            required
          />
          <Button type="submit" disabled={busy}>
            Import existing knowledge
          </Button>
          {importNotice && (
            <p role="status" className="text-sm">
              {importNotice}
            </p>
          )}
        </form>
      </SettingsSection>
    </div>
  );
}
