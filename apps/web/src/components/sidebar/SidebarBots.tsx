import { BOT_ICON_CHOICES } from "@t3tools/shared/bot-icons";
import { latestBotConversation } from "@t3tools/shared/bot-conversations";
import { BotRoutineHistory } from "./BotRoutineHistory";
import { BotRoutinesEditor } from "./BotRoutinesEditor";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  type BotProfile,
  type BotRoutine,
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { standaloneBotWorkspace, isStandaloneBotProject } from "@t3tools/shared/bot-workspace";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { BotIcon, PencilIcon, PinIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { newBotId, newThreadId } from "../../lib/utils";
import { useProjects, useThreadShells, waitForProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "../ui/sidebar";

interface BotEditorTarget {
  environmentId: EnvironmentId;
  profile?: BotProfile;
}

export function SidebarBots() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings);
  const createThread = useAtomCommand(threadEnvironment.create);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [editor, setEditor] = useState<BotEditorTarget | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (
      !pending ||
      !threads.some(
        (thread) =>
          thread.environmentId === pending.environmentId && thread.id === pending.threadId,
      )
    )
      return;
    setPending(null);
    void navigate({ to: "/$environmentId/$threadId", params: pending });
  }, [pending, threads, navigate]);
  const entries = useMemo(
    () =>
      [...configs]
        .flatMap(([environmentId, config]) =>
          Object.values(config.settings.bots).map((profile) => ({ environmentId, profile })),
        )
        .sort(
          (left, right) =>
            Number(right.profile.pinned) - Number(left.profile.pinned) ||
            left.profile.createdAt.localeCompare(right.profile.createdAt),
        ),
    [configs],
  );
  const firstEnvironment = configs.keys().next().value;

  const write = async (environmentId: EnvironmentId, profile: BotProfile) => {
    const result = await saveSettings({
      environmentId,
      input: { patch: { bots: { [profile.id]: profile } } },
    });
    return result._tag === "Success";
  };
  const openBot = async (environmentId: EnvironmentId, profile: BotProfile, fresh = false) => {
    if (busy || pending) return;
    setError(null);
    const existing = !fresh ? latestBotConversation(threads, environmentId, profile.id) : undefined;
    if (existing) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: existing.id },
      });
      return;
    }
    const config = configs.get(environmentId);
    if (!config) {
      setError("This environment is unavailable.");
      return;
    }
    setBusy(true);
    try {
      let project = projects.find(
        (entry) => entry.environmentId === environmentId && entry.id === profile.projectId,
      );
      if (profile.projectId === null) {
        if (!config.botWorkspaceRoot) {
          setError("This environment needs an update to support standalone bots.");
          return;
        }
        const workspace = standaloneBotWorkspace(config.botWorkspaceRoot, profile.id);
        project = projects.find(
          (entry) => entry.environmentId === environmentId && entry.id === workspace.projectId,
        );
        if (!project) {
          await createProject({
            environmentId,
            input: {
              ...workspace,
              title: profile.name,
              createWorkspaceRootIfMissing: true,
              defaultModelSelection: null,
              createdAt: new Date().toISOString(),
            },
          });
          project = await waitForProject({ environmentId, projectId: workspace.projectId });
        }
        if (project.workspaceRoot !== workspace.workspaceRoot) {
          setError("The bot workspace does not match its expected location.");
          return;
        }
      }
      if (!project) {
        setError("This bot's project is unavailable. Edit the bot to choose a project.");
        return;
      }
      const threadId = newThreadId();
      const defaults = resolveProjectSettings(config.settings, project.id, project).settings;
      const result = await createThread({
        environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: profile.name,
          bot: { id: profile.id, name: profile.name, instructions: profile.instructions },
          modelSelection: profile.modelSelection,
          runtimeMode: defaults.defaultRuntimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Success") setPending({ environmentId, threadId });
      else setError("The conversation could not be created.");
    } catch {
      setError("The bot workspace could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Bots" className="px-2 py-2">
      <div className="flex items-center justify-between px-2 text-xs text-muted-foreground">
        <span>Bots</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Add bot"
          disabled={!firstEnvironment}
          onClick={() => firstEnvironment && setEditor({ environmentId: firstEnvironment })}
        >
          <PlusIcon />
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <SidebarMenu>
          {entries
            .filter(({ profile }) => showArchived || !profile.archived)
            .map(({ environmentId, profile }) => (
              <SidebarMenuItem key={`${environmentId}:${profile.id}`}>
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <SidebarMenuButton
                      disabled={busy || pending !== null || profile.archived}
                      onClick={() => void openBot(environmentId, profile)}
                      title={profile.description || profile.name}
                    >
                      {profile.icon ? <span aria-hidden="true">{profile.icon}</span> : <BotIcon />}
                      <span>{profile.name}</span>
                      {profile.pinned ? <PinIcon aria-label="Pinned" /> : null}
                    </SidebarMenuButton>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`New conversation with ${profile.name}`}
                    disabled={busy || pending !== null || profile.archived}
                    onClick={() => void openBot(environmentId, profile, true)}
                  >
                    <PlusIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${profile.name}`}
                    onClick={() => setEditor({ environmentId, profile })}
                  >
                    <PencilIcon />
                  </Button>
                </div>
                {threads.some(
                  (thread) =>
                    thread.environmentId === environmentId &&
                    thread.bot?.id === profile.id &&
                    thread.id.startsWith("bot-routine:") &&
                    thread.archivedAt === null,
                ) ? (
                  <details className="pl-6 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Routine conversations</summary>
                    {threads
                      .filter(
                        (thread) =>
                          thread.environmentId === environmentId &&
                          thread.bot?.id === profile.id &&
                          thread.id.startsWith("bot-routine:") &&
                          thread.archivedAt === null,
                      )
                      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                      .map((thread) => (
                        <button
                          key={thread.id}
                          type="button"
                          className="block w-full truncate py-1 text-left"
                          onClick={() =>
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: { environmentId, threadId: thread.id },
                            })
                          }
                        >
                          {thread.title} - {thread.latestTurn?.state ?? "starting"}
                        </button>
                      ))}
                  </details>
                ) : null}
              </SidebarMenuItem>
            ))}
        </SidebarMenu>
      </div>
      {entries.some(({ profile }) => profile.archived) ? (
        <Button variant="ghost" size="sm" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? "Hide archived bots" : "Show archived bots"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="px-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {editor ? (
        <BotEditor
          key={`${editor.environmentId}:${editor.profile?.id ?? "new"}`}
          target={editor}
          configs={configs}
          onClose={() => setEditor(null)}
          onSave={write}
        />
      ) : null}
    </section>
  );
}

function BotEditor({
  target,
  configs,
  onClose,
  onSave,
}: {
  target: BotEditorTarget;
  configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  onClose: () => void;
  onSave: (environmentId: EnvironmentId, profile: BotProfile) => Promise<boolean>;
}) {
  const projects = useProjects().filter(
    (project) =>
      project.id !== "j1-home" &&
      !isStandaloneBotProject(project.id) &&
      configs.has(project.environmentId),
  );
  const { environments } = useEnvironments();
  const [environmentId, setEnvironmentId] = useState(target.environmentId);
  const config = configs.get(environmentId);
  const projectOptions = projects.filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState(target.profile?.projectId ?? null);
  const [name, setName] = useState(target.profile?.name ?? "");
  const [icon, setIcon] = useState(target.profile?.icon ?? "");
  const [voiceURI, setVoiceURI] = useState(target.profile?.voiceURI ?? "");
  const [voiceAutoPlay, setVoiceAutoPlay] = useState(target.profile?.voiceAutoPlay ?? false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const update = () => setVoices(window.speechSynthesis.getVoices());
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  const [description, setDescription] = useState(target.profile?.description ?? "");
  const [instructions, setInstructions] = useState(target.profile?.instructions ?? "");
  const [pinned, setPinned] = useState(target.profile?.pinned ?? false);
  const [archived, setArchived] = useState(target.profile?.archived ?? false);
  const [routines, setRoutines] = useState<ReadonlyArray<BotRoutine>>(
    target.profile?.routines ?? [],
  );
  const modelOptions =
    config?.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        key: JSON.stringify([provider.instanceId, model.slug]),
        label: `${provider.displayName ?? provider.driver} · ${model.name}`,
        selection: { instanceId: provider.instanceId, model: model.slug },
        unavailable:
          provider.availability === "unavailable" ||
          provider.status === "disabled" ||
          provider.status === "error",
      })),
    ) ?? [];
  const initialSelection = target.profile?.modelSelection ?? config?.settings.defaultModelSelection;
  const [modelKey, setModelKey] = useState(
    initialSelection
      ? JSON.stringify([initialSelection.instanceId, initialSelection.model])
      : (modelOptions.find((model) => !model.unavailable)?.key ?? ""),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model =
    modelOptions.find((option) => option.key === modelKey)?.selection ??
    (target.profile &&
    JSON.stringify([
      target.profile.modelSelection.instanceId,
      target.profile.modelSelection.model,
    ]) === modelKey
      ? target.profile.modelSelection
      : null);
  const save = async () => {
    if (
      !model ||
      !name.trim() ||
      saving ||
      routines.some((routine) => !routine.name.trim() || !routine.prompt.trim())
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const profile: BotProfile = {
        id: target.profile?.id ?? newBotId(),
        name: name.trim(),
        routines: routines.map((routine) => ({
          ...routine,
          name: routine.name.trim(),
          prompt: routine.prompt.trim(),
        })),
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        ...(voiceURI ? { voiceURI } : {}),
        voiceAutoPlay,
        description: description.trim(),
        instructions: instructions.trim(),
        projectId,
        modelSelection:
          target.profile &&
          modelKey ===
            JSON.stringify([
              target.profile.modelSelection.instanceId,
              target.profile.modelSelection.model,
            ])
            ? target.profile.modelSelection
            : model,
        pinned,
        archived,
        createdAt: target.profile?.createdAt ?? now,
        updatedAt: now,
      };
      if (await onSave(environmentId, profile)) onClose();
      else setError("The bot was not saved. Your changes are still here.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{target.profile ? "Edit bot" : "Create bot"}</DialogTitle>
          <DialogDescription>
            A reusable agent with its own instructions and model. Each conversation keeps the
            profile it started with.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-4 p-4"
        >
          {!target.profile && environments.length > 1 ? (
            <label className="grid gap-1">
              Environment
              <Select
                value={environmentId}
                onValueChange={(value) => {
                  const next = environments.find((entry) => entry.environmentId === value);
                  if (!next) return;
                  setEnvironmentId(next.environmentId);
                  setProjectId(null);
                  setModelKey("");
                }}
              >
                <SelectTrigger>
                  <SelectValue>
                    {environments.find((entry) => entry.environmentId === environmentId)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environments
                    .filter((entry) => configs.has(entry.environmentId))
                    .map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {entry.label}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
            </label>
          ) : null}
          <label className="grid gap-1">
            Name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              autoFocus
            />
          </label>
          <div className="grid gap-2">
            <span>Choose an icon</span>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Bot icon choices">
              {BOT_ICON_CHOICES.map((choice) => (
                <Button
                  key={choice.label}
                  type="button"
                  size="icon"
                  variant={icon === choice.icon ? "secondary" : "ghost"}
                  aria-label={choice.label}
                  aria-pressed={icon === choice.icon}
                  onClick={() => setIcon(choice.icon)}
                >
                  <span aria-hidden="true">{choice.icon}</span>
                </Button>
              ))}
              <Button type="button" size="sm" variant="ghost" onClick={() => setIcon("")}>
                Clear
              </Button>
            </div>
          </div>
          <label className="grid gap-1">
            Icon (emoji)
            <Input
              value={icon}
              onChange={(event) => setIcon(event.target.value)}
              maxLength={16}
              placeholder="🤖"
            />
          </label>
          <label className="grid gap-1">
            Description
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={500}
            />
          </label>
          <label className="grid gap-1">
            Project
            <Select
              value={projectId ?? "standalone"}
              onValueChange={(value) =>
                setProjectId(projectOptions.find((project) => project.id === value)?.id ?? null)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Standalone">
                  {projectOptions.find((project) => project.id === projectId)?.title ??
                    "Standalone"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="standalone">Standalone</SelectItem>
                {projectOptions.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="grid gap-1">
            Model
            <Select value={modelKey} onValueChange={(value) => value && setModelKey(value)}>
              <SelectTrigger>
                <SelectValue placeholder="Choose model">
                  {modelOptions.find((option) => option.key === modelKey)?.label ??
                    target.profile?.modelSelection.model}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {modelOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key} disabled={option.unavailable}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="grid gap-1">
            Voice on this device
            <Select
              value={voiceURI || "system-default"}
              onValueChange={(value) =>
                setVoiceURI(value === "system-default" ? "" : (value ?? ""))
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {voices.find((voice) => voice.voiceURI === voiceURI)?.name ??
                    (voiceURI || "System default")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="system-default">System default</SelectItem>
                {voices.map((voice) => (
                  <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} ({voice.lang})
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={voiceAutoPlay}
              onChange={(event) => setVoiceAutoPlay(event.target.checked)}
            />{" "}
            Read new replies aloud
          </label>
          <BotRoutinesEditor routines={routines} onChange={setRoutines} />
          {target.profile ? (
            <BotRoutineHistory
              environmentId={environmentId}
              botId={target.profile.id}
              routines={routines}
            />
          ) : null}
          <label className="grid gap-1">
            Instructions
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={32_000}
              rows={6}
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
            />
            Pin bot
          </label>
          {target.profile ? (
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />
              Archive bot
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                saving ||
                !name.trim() ||
                !model ||
                routines.some((routine) => !routine.name.trim() || !routine.prompt.trim())
              }
            >
              {saving ? "Saving…" : "Save bot"}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
