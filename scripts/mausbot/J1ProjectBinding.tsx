import { useEffect, useState } from "react";
import { useStore, type Bot } from "@/state/store";
import { Select } from "./Select";
import { Field } from "./bot-settings/field";
import { useBotEditor } from "./bot-settings/BotEditorContext";

type Project = { id: string; title: string; workspaceRoot: string };
export function J1ProjectBinding({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const { request: api, draft } = useBotEditor();
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(bot.j1ProjectId ?? "");
  const [locked, setLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    if (draft || !state.config?.j1Managed) return;
    void Promise.all([
      api<Project[]>("/api/j1/projects"),
      api<{ projectId?: string; locked: boolean }>(
        `/api/j1/thread-project?botId=${encodeURIComponent(bot.id)}&threadId=${encodeURIComponent(bot.threadId)}`,
      ),
    ]).then(
      ([value, binding]) => {
        if (!current || !Array.isArray(value)) return;
        setError("");
        setProjects(value);
        setSelected(
          value.some((project) => project.id === binding.projectId) ? binding.projectId! : "",
        );
        setLocked(binding.locked);
      },
      () => {
        if (current) setError("J1 projects could not be loaded.");
      },
    );
    return () => {
      current = false;
    };
  }, [api, state.config?.j1Managed, bot.id, bot.threadId, draft]);
  if (draft || !state.config?.j1Managed) return null;
  return (
    <Field label="J1 project for this thread">
      <p className="mb-2 text-[13px] text-ink-secondary">
        Use this project's folder, instructions, files and memory in this bot thread. Existing
        sessions keep their project; start a new thread to work on another project.
      </p>
      <Select
        value={selected}
        disabled={locked || saving}
        onChange={(event) => {
          const projectId = event.target.value;
          setSaving(true);
          setError("");
          void api("/api/j1/thread-project", {
            method: "PATCH",
            body: JSON.stringify({ botId: bot.id, threadId: bot.threadId, projectId }),
          })
            .then(
              () => setSelected(projectId),
              (error) => setError(String(error)),
            )
            .finally(() => setSaving(false));
        }}
      >
        <option value="">Bot workspace</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.title}
          </option>
        ))}
      </Select>
      {error && <p role="alert">{error}</p>}
    </Field>
  );
}
