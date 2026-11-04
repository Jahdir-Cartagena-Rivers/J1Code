import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** Environment preferences use exact provider instances, including remote environments. */
export function AutoModelSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const update = useUpdateEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const policy = useScopedSettings((value) => value.autoModelPolicy);
  const updateModels = useUpdateScopedSettings();
  const [fast, setFast] = useState<ModelSelection | null>(
    policy?.mode === "auto" ? policy.fast : null,
  );
  const [deep, setDeep] = useState<ModelSelection | null>(
    policy?.mode === "auto" ? policy.deep : null,
  );
  const [fastContext, setFastContext] = useState(
    policy?.mode === "auto" && typeof policy.capabilities?.fast?.contextWindow === "number"
      ? String(policy.capabilities.fast.contextWindow)
      : "",
  );
  const [deepContext, setDeepContext] = useState(
    policy?.mode === "auto" && typeof policy.capabilities?.deep?.contextWindow === "number"
      ? String(policy.capabilities.deep.contextWindow)
      : "",
  );
  const [fastImages, setFastImages] = useState(
    policy?.mode === "auto" && policy.capabilities?.fast?.images === true,
  );
  const [deepImages, setDeepImages] = useState(
    policy?.mode === "auto" && policy.capabilities?.deep?.images === true,
  );
  useEffect(() => {
    if (policy?.mode === "auto") {
      setFast(policy.fast);
      setDeep(policy.deep);
      setFastImages(policy.capabilities?.fast?.images === true);
      setDeepImages(policy.capabilities?.deep?.images === true);
      setFastContext(
        typeof policy.capabilities?.fast?.contextWindow === "number"
          ? String(policy.capabilities.fast.contextWindow)
          : "",
      );
      setDeepContext(
        typeof policy.capabilities?.deep?.contextWindow === "number"
          ? String(policy.capabilities.deep.contextWindow)
          : "",
      );
    }
  }, [policy]);
  const choices = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: JSON.stringify([provider.instanceId, model.slug]),
      label: `${provider.displayName ?? provider.driver} · ${model.name}`,
      selection: { instanceId: provider.instanceId, model: model.slug },
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const save = async (enabled: boolean) => {
    if (enabled && (!fast || !deep)) return;
    try {
      await updateModels({
        autoModelPolicy:
          enabled && fast && deep
            ? {
                mode: "auto",
                fast,
                deep,
                capabilities: {
                  fast: { tools: true, images: fastImages, contextWindow: Number(fastContext) },
                  deep: { tools: true, images: deepImages, contextWindow: Number(deepContext) },
                },
              }
            : { mode: "manual" },
      });
      setError(null);
    } catch {
      setError("Could not save model preferences. Try again.");
    }
  };
  return (
    <section className="space-y-3 p-6" aria-label="Automatic model selection">
      <h2 className="text-sm font-medium">Automatic model selection</h2>
      <p className="text-sm">Current selection: {policy?.mode === "auto" ? "Auto" : "Manual"}</p>
      <p className="text-sm text-muted-foreground">
        Choose models for quick requests and substantial work. Manual model selections take
        precedence.
      </p>
      {(
        [
          ["Fast model", fast, setFast],
          ["Deep-work model", deep, setDeep],
        ] as const
      ).map(([label, selection, change]) => (
        <div key={label} className="space-y-1">
          <span className="text-sm">{label}</span>
          <Select
            items={choices}
            value={selection ? JSON.stringify([selection.instanceId, selection.model]) : null}
            onValueChange={(value) => {
              const choice = choices.find((item) => item.value === value);
              if (choice) {
                change(choice.selection);
                if (label === "Fast model") {
                  setFastContext("");
                  setFastImages(false);
                } else {
                  setDeepContext("");
                  setDeepImages(false);
                }
              }
            }}
          >
            <SelectTrigger aria-label={label}>
              <SelectValue placeholder="Choose a configured model" />
            </SelectTrigger>
            <SelectPopup>
              {choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ))}
      <p className="text-sm text-muted-foreground">
        Choose models that support agent tools. When a provider does not report context capacity,
        enter its documented token limit so Auto can check request size.
      </p>
      <label className="block text-sm">
        Fast model context capacity
        <Input
          type="number"
          min={1}
          aria-label="Fast model context capacity in tokens"
          value={fastContext}
          onChange={(event) => setFastContext(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Deep-work model context capacity
        <Input
          type="number"
          min={1}
          aria-label="Deep-work model context capacity in tokens"
          value={deepContext}
          onChange={(event) => setDeepContext(event.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Fast model supports images"
            checked={fastImages}
            onCheckedChange={setFastImages}
          />
          Fast model supports images
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Deep-work model supports images"
            checked={deepImages}
            onCheckedChange={setDeepImages}
          />
          Deep-work model supports images
        </label>
      </div>
      <p className="text-sm text-muted-foreground">
        Enable image support only for models that accept images. Context budgets are estimates; the
        provider manages actual limits and compaction.
      </p>
      <div className="flex gap-2">
        <Button
          disabled={
            !fast ||
            !deep ||
            !Number.isSafeInteger(Number(fastContext)) ||
            Number(fastContext) <= 0 ||
            !Number.isSafeInteger(Number(deepContext)) ||
            Number(deepContext) <= 0
          }
          onClick={() => void save(true)}
        >
          Enable Auto
        </Button>
        <Button variant="outline" onClick={() => void save(false)}>
          Use manual selection
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <h2 className="text-sm font-medium">Request routing</h2>
      <p className="text-sm text-muted-foreground">
        Suggest asks you to choose a destination. Auto routes when the work has a clear owner.
        Original conversations remain available.
      </p>
      <Select
        items={[
          { value: "off", label: "Off" },
          { value: "suggest", label: "Suggest" },
          { value: "auto", label: "Auto" },
        ]}
        value={settings.chatRoutingMode}
        onValueChange={(value) => {
          if (value !== "off" && value !== "suggest" && value !== "auto") return;
          update({ chatRoutingMode: value });
        }}
      >
        <SelectTrigger aria-label="Request routing mode">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="off">Off</SelectItem>
          <SelectItem value="suggest">Suggest</SelectItem>
          <SelectItem value="auto">Auto</SelectItem>
        </SelectPopup>
      </Select>
    </section>
  );
}
