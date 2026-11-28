import { botVoice, type BotVoice } from "../../native/botVoice";
import { BOT_ICON_CHOICES } from "@j1code/shared/bot-icons";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@j1code/client-runtime/state/shell";
import { scopeThreadRef } from "@j1code/client-runtime/environment";
import {
  BotId,
  BotRoutine,
  ThreadId,
  type BotProfile,
  type EnvironmentId,
  type ServerConfig,
} from "@j1code/contracts";
import { standaloneBotWorkspace, isStandaloneBotProject } from "@j1code/shared/bot-workspace";
import { latestBotConversation } from "@j1code/shared/bot-conversations";
import { resolveProjectSettings } from "@j1code/shared/projectSettings";
import * as Schema from "effect/Schema";
import { BotRoutineHistory } from "./BotRoutineHistory";
import { BotRoutinesEditor } from "./BotRoutinesEditor";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Switch,
  TextInput,
  View,
} from "react-native";
import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import { RowPressable } from "../../components/ui/RowPressable";
import { uuidv4 } from "../../lib/uuid";
import { useProjects, useThreadShells, waitForProject } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { projectEnvironment } from "../../state/projects";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShell } from "../threads/threadForkNavigation";

const isRoutine = Schema.is(BotRoutine);

interface Target {
  environmentId: EnvironmentId;
  profile?: BotProfile;
}

export function BotRoster({
  onSelectThread,
}: {
  onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const create = useAtomCommand(threadEnvironment.create);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [editor, setEditor] = useState<Target | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [waitingForOpen, setWaitingForOpen] = useState(false);
  const openingCancelled = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const entries = useMemo(
    () =>
      [...configs]
        .flatMap(([environmentId, config]) =>
          Object.values(config.settings.bots).map((profile) => ({ environmentId, profile })),
        )
        .sort(
          (a, b) =>
            Number(b.profile.pinned) - Number(a.profile.pinned) ||
            a.profile.createdAt.localeCompare(b.profile.createdAt),
        ),
    [configs],
  );
  const firstEnvironment = configs.keys().next().value;
  const open = async (environmentId: EnvironmentId, profile: BotProfile, fresh: boolean) => {
    if (creating) return;
    setError(null);
    const existing = !fresh ? latestBotConversation(threads, environmentId, profile.id) : undefined;
    if (existing) {
      onSelectThread(existing);
      return;
    }
    const config = configs.get(environmentId);
    if (!config) {
      setError("This environment is unavailable.");
      return;
    }
    setCreating(true);
    const openConversation = async () => {
      // oxlint-disable-next-line react/purity -- The timestamp is captured in the user's open-conversation event.
      const createdAt = new Date().toISOString();
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
              createdAt,
            },
          });
          project =
            (await waitForProject({ environmentId, projectId: workspace.projectId })) ?? undefined;
        }
        if (project && project.workspaceRoot !== workspace.workspaceRoot) {
          setError("The bot workspace does not match its expected location.");
          return;
        }
      }
      if (!project) {
        setError("This bot's project is unavailable. Edit the bot to choose a project.");
        return;
      }
      const threadId = ThreadId.make(uuidv4());
      const settings = resolveProjectSettings(config.settings, project.id, project).settings;
      const result = await create({
        environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: profile.name,
          bot: { id: profile.id, name: profile.name, instructions: profile.instructions },
          modelSelection: profile.modelSelection,
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      });
      if (result._tag !== "Success") {
        setError("The conversation could not be created.");
        return;
      }
      const ref = scopeThreadRef(environmentId, threadId);
      openingCancelled.current = false;
      setWaitingForOpen(true);
      await waitForThreadShell(ref);
      if (openingCancelled.current) return;
      const thread = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
      if (thread) onSelectThread(thread);
      else setError("The conversation was created. Reopen it from the bot's conversation list.");
    };
    await openConversation()
      .catch(() => setError("The bot workspace could not be opened. Try again."))
      .finally(() => {
        setWaitingForOpen(false);
        setCreating(false);
      });
  };

  return (
    <View className="px-3 py-2" accessibilityLabel="Bots">
      <View className="flex-row items-center justify-between">
        <AppText className="font-t3-medium">Bots</AppText>
        <ControlPill
          label="Add bot"
          variant="pill"
          disabled={!firstEnvironment}
          onPress={() => firstEnvironment && setEditor({ environmentId: firstEnvironment })}
        />
      </View>
      <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
        {entries
          .filter(({ profile }) => showArchived || !profile.archived)
          .map(({ environmentId, profile }) => (
            <View key={`${environmentId}:${profile.id}`} className="flex-row items-center">
              <View className="flex-1">
                <RowPressable
                  accessibilityLabel={profile.name}
                  disabled={creating || profile.archived}
                  onPress={() => void open(environmentId, profile, false)}
                >
                  <AppText>
                    {profile.pinned ? "★ " : ""}
                    {profile.icon ? `${profile.icon} ` : ""}
                    {profile.name}
                    {profile.archived ? " (Archived)" : ""}
                  </AppText>
                </RowPressable>
              </View>
              <Menu
                title={profile.name}
                actions={[
                  {
                    id: "new",
                    title: "New conversation",
                    attributes: { disabled: profile.archived },
                  },
                  { id: "edit", title: "Edit bot" },
                  ...threads
                    .filter(
                      (thread) =>
                        thread.environmentId === environmentId &&
                        thread.bot?.id === profile.id &&
                        thread.id.startsWith("bot-routine:") &&
                        thread.archivedAt === null,
                    )
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map((thread) => ({
                      id: `thread:${thread.id}`,
                      title: `${thread.title} - ${thread.latestRun?.status ?? "starting"}`,
                    })),
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "edit") setEditor({ environmentId, profile });
                  else if (nativeEvent.event === "new") void open(environmentId, profile, true);
                  else if (nativeEvent.event.startsWith("thread:")) {
                    const found = threads.find(
                      (thread) =>
                        thread.environmentId === environmentId &&
                        `thread:${thread.id}` === nativeEvent.event,
                    );
                    if (found) onSelectThread(found);
                  }
                }}
              >
                <ControlPill
                  label="More"
                  accessibilityLabel={`Options for ${profile.name}`}
                  variant="pill"
                />
              </Menu>
            </View>
          ))}
      </ScrollView>
      {entries.some(({ profile }) => profile.archived) ? (
        <Button
          tone="text"
          label={showArchived ? "Hide archived bots" : "Show archived bots"}
          onPress={() => setShowArchived(!showArchived)}
        />
      ) : null}
      {waitingForOpen ? (
        <Button
          tone="text"
          label="Cancel opening conversation"
          onPress={() => {
            openingCancelled.current = true;
            setWaitingForOpen(false);
          }}
        />
      ) : null}
      {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
      {editor ? (
        <BotEditor
          key={`${editor.environmentId}:${editor.profile?.id ?? "new"}`}
          target={editor}
          configs={configs}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </View>
  );
}

function BotEditor({
  target,
  configs,
  onClose,
}: {
  target: Target;
  configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  onClose: () => void;
}) {
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings);
  const projects = useProjects().filter(
    (project) =>
      project.id !== "j1-home" &&
      !isStandaloneBotProject(project.id) &&
      configs.has(project.environmentId) &&
      (!target.profile || project.environmentId === target.environmentId),
  );
  const [projectKey, setProjectKey] = useState(
    target.profile?.projectId
      ? JSON.stringify([target.environmentId, target.profile.projectId])
      : "standalone",
  );
  const project = projects.find(
    (entry) => JSON.stringify([entry.environmentId, entry.id]) === projectKey,
  );
  const environmentId = project?.environmentId ?? target.environmentId;
  const config = configs.get(environmentId);
  const [name, setName] = useState(target.profile?.name ?? "");
  const [icon, setIcon] = useState(target.profile?.icon ?? "");
  const [description, setDescription] = useState(target.profile?.description ?? "");
  const [instructions, setInstructions] = useState(target.profile?.instructions ?? "");
  const [voiceURI, setVoiceURI] = useState(target.profile?.voiceURI ?? "");
  const [voiceAutoPlay, setVoiceAutoPlay] = useState(target.profile?.voiceAutoPlay ?? false);
  const [voices, setVoices] = useState<ReadonlyArray<BotVoice>>([]);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Ask the native voice service for its available voices.
  useEffect(() => {
    let mounted = true;
    void botVoice
      ?.voices()
      .then((available) => {
        if (mounted) setVoices(available);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  const [pinned, setPinned] = useState(target.profile?.pinned ?? false);
  const [archived, setArchived] = useState(target.profile?.archived ?? false);
  const [routines, setRoutines] = useState<ReadonlyArray<BotRoutine>>(
    target.profile?.routines ?? [],
  );
  const models =
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
  const initial = target.profile?.modelSelection ?? config?.settings.defaultModelSelection;
  const [modelKey, setModelKey] = useState(
    initial
      ? JSON.stringify([initial.instanceId, initial.model])
      : (models.find((model) => !model.unavailable)?.key ?? ""),
  );
  const selected = models.find((model) => model.key === modelKey);
  const selection =
    target.profile &&
    modelKey ===
      JSON.stringify([
        target.profile.modelSelection.instanceId,
        target.profile.modelSelection.model,
      ])
      ? target.profile.modelSelection
      : selected?.selection;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!selection || !name.trim() || saving || routines.some((routine) => !isRoutine(routine)))
      return;
    setSaving(true);
    setError(null);
    const commit = async () => {
      const now = new Date().toISOString();
      const profile: BotProfile = {
        id: target.profile?.id ?? BotId.make(uuidv4()),
        name: name.trim(),
        routines,
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        ...(voiceURI ? { voiceURI } : {}),
        voiceAutoPlay,
        description: description.trim(),
        instructions: instructions.trim(),
        projectId: project?.id ?? null,
        modelSelection: selection,
        pinned,
        archived,
        createdAt: target.profile?.createdAt ?? now,
        updatedAt: now,
      };
      const result = await saveSettings({
        environmentId,
        input: { patch: { bots: { [profile.id]: profile } } },
      });
      if (result._tag === "Success") onClose();
      else setError("The bot was not saved. Your changes are still here.");
    };
    await commit()
      .catch(() => setError("The bot was not saved. Your changes are still here."))
      .finally(() => setSaving(false));
  };
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!saving) onClose();
      }}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-screen"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: 24, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <AppText className="text-xl font-t3-medium">
            {target.profile ? "Edit bot" : "Create bot"}
          </AppText>
          <AppText>Each conversation keeps the profile it started with.</AppText>
          <View className="gap-1">
            <AppText>Name</AppText>
            <TextInput
              accessibilityLabel="Bot name"
              className="rounded-lg border border-border p-3 text-foreground"
              value={name}
              onChangeText={setName}
              maxLength={80}
            />
          </View>
          <View className="gap-2">
            <AppText>Choose an icon</AppText>
            <View className="flex-row flex-wrap gap-1">
              {BOT_ICON_CHOICES.map((choice) => (
                <ControlPill
                  key={choice.label}
                  accessibilityLabel={choice.label}
                  label={choice.icon}
                  variant={icon === choice.icon ? "primary" : "pill"}
                  onPress={() => setIcon(choice.icon)}
                />
              ))}
              <ControlPill label="Clear" variant="pill" onPress={() => setIcon("")} />
            </View>
          </View>
          <View className="gap-1">
            <AppText>Icon (emoji)</AppText>
            <TextInput
              accessibilityLabel="Bot icon"
              className="rounded-lg border border-border p-3 text-foreground"
              value={icon}
              onChangeText={setIcon}
              maxLength={16}
              placeholder="🤖"
            />
          </View>
          <View className="gap-1">
            <AppText>Description</AppText>
            <TextInput
              accessibilityLabel="Bot description"
              className="rounded-lg border border-border p-3 text-foreground"
              value={description}
              onChangeText={setDescription}
              maxLength={500}
            />
          </View>
          <Menu
            title="Project"
            actions={[
              { id: "standalone", title: "Standalone" },
              ...projects.map((entry) => ({
                id: JSON.stringify([entry.environmentId, entry.id]),
                title: entry.title,
              })),
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "standalone") {
                setProjectKey("standalone");
                return;
              }
              const next = projects.find(
                (entry) => JSON.stringify([entry.environmentId, entry.id]) === nativeEvent.event,
              );
              if (next) {
                if (next.environmentId !== environmentId) setModelKey("");
                setProjectKey(nativeEvent.event);
              }
            }}
          >
            <ControlPill
              label={project?.title ?? "Standalone"}
              accessibilityLabel="Bot project"
              variant="pill"
            />
          </Menu>
          <Menu
            title="Model"
            actions={models.map((model) => ({
              id: model.key,
              title: model.label,
              attributes: { disabled: model.unavailable },
            }))}
            onPressAction={({ nativeEvent }) => setModelKey(nativeEvent.event)}
          >
            <ControlPill
              label={selected?.label ?? selection?.model ?? "Choose model"}
              accessibilityLabel="Bot model"
              variant="pill"
            />
          </Menu>
          {botVoice ? (
            <View className="gap-2">
              <AppText>Voice</AppText>
              <Menu
                title="Bot voice"
                actions={[
                  { id: "default", title: "Device default" },
                  ...voices.map((voice) => ({
                    id: voice.id,
                    title: `${voice.name} (${voice.language})`,
                  })),
                ]}
                onPressAction={({ nativeEvent }) =>
                  setVoiceURI(nativeEvent.event === "default" ? "" : nativeEvent.event)
                }
              >
                <ControlPill
                  label={voices.find((voice) => voice.id === voiceURI)?.name ?? "Device default"}
                  accessibilityLabel="Bot voice"
                  variant="pill"
                />
              </Menu>
              <View className="flex-row items-center justify-between">
                <AppText>Read replies automatically</AppText>
                <Switch
                  accessibilityLabel="Read replies automatically"
                  value={voiceAutoPlay}
                  onValueChange={setVoiceAutoPlay}
                />
              </View>
            </View>
          ) : (
            <AppText>Update the mobile app to use bot voice.</AppText>
          )}
          <BotRoutinesEditor routines={routines} onChange={setRoutines} />
          {target.profile ? (
            <BotRoutineHistory
              environmentId={environmentId}
              botId={target.profile.id}
              routines={routines}
            />
          ) : null}
          <View className="gap-1">
            <AppText>Instructions</AppText>
            <TextInput
              accessibilityLabel="Bot instructions"
              className="min-h-40 rounded-lg border border-border p-3 text-foreground"
              value={instructions}
              onChangeText={setInstructions}
              maxLength={32_000}
              multiline
              textAlignVertical="top"
            />
          </View>
          <View className="flex-row items-center justify-between">
            <AppText>Pin bot</AppText>
            <Switch accessibilityLabel="Pin bot" value={pinned} onValueChange={setPinned} />
          </View>
          {target.profile ? (
            <View className="flex-row items-center justify-between">
              <AppText>Archive bot</AppText>
              <Switch
                accessibilityLabel="Archive bot"
                value={archived}
                onValueChange={setArchived}
              />
            </View>
          ) : null}
          {routines.some((routine) => !isRoutine(routine)) ? (
            <AppText accessibilityRole="alert">
              Complete each routine name, instructions and valid UTC start time before saving.
            </AppText>
          ) : null}
          {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
          <Button
            label={saving ? "Saving…" : "Save bot"}
            disabled={
              saving ||
              !name.trim() ||
              !selection ||
              routines.some((routine) => !isRoutine(routine))
            }
            onPress={() => void save()}
            tone="primary"
          />
          <Button label="Cancel" disabled={saving} onPress={onClose} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
