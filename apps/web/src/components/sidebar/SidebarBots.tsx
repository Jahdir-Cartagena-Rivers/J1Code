import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  type BotProfile,
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { BotIcon, PencilIcon, PinIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { newBotId, newThreadId } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
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
  const firstProject = projects.find(
    (project) => project.id !== "j1-home" && configs.has(project.environmentId),
  );

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
    const existing = !fresh
      ? threads
          .filter(
            (thread) =>
              thread.environmentId === environmentId &&
              thread.bot?.id === profile.id &&
              thread.archivedAt === null,
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
      : undefined;
    if (existing) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: existing.id },
      });
      return;
    }
    const project = projects.find(
      (entry) => entry.environmentId === environmentId && entry.id === profile.projectId,
    );
    const config = configs.get(environmentId);
    if (!project || !config) {
      setError("This bot's project is unavailable. Edit the bot to choose a project.");
      return;
    }
    setBusy(true);
    try {
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
          disabled={!firstProject}
          onClick={() => firstProject && setEditor({ environmentId: firstProject.environmentId })}
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
                      <BotIcon />
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
    (project) => project.id !== "j1-home" && configs.has(project.environmentId),
  );
  const { environments } = useEnvironments();
  const [environmentId, setEnvironmentId] = useState(target.environmentId);
  const config = configs.get(environmentId);
  const projectOptions = projects.filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState(
    target.profile?.projectId ?? projectOptions[0]?.id ?? null,
  );
  const [name, setName] = useState(target.profile?.name ?? "");
  const [description, setDescription] = useState(target.profile?.description ?? "");
  const [instructions, setInstructions] = useState(target.profile?.instructions ?? "");
  const [pinned, setPinned] = useState(target.profile?.pinned ?? false);
  const [archived, setArchived] = useState(target.profile?.archived ?? false);
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
    if (!projectId || !model || !name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const profile: BotProfile = {
        id: target.profile?.id ?? newBotId(),
        name: name.trim(),
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
      <DialogPopup>
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
                  setProjectId(
                    projects.find(
                      (project) =>
                        project.environmentId === next.environmentId && project.id !== "j1-home",
                    )?.id ?? null,
                  );
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
              value={projectId}
              onValueChange={(value) =>
                setProjectId(projectOptions.find((project) => project.id === value)?.id ?? null)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose project">
                  {projectOptions.find((project) => project.id === projectId)?.title}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
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
            <Button type="submit" disabled={saving || !name.trim() || !projectId || !model}>
              {saving ? "Saving…" : "Save bot"}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
