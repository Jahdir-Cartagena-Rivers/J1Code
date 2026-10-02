import { useId, useState } from "react";
import { type EnvironmentId } from "@t3tools/contracts";

import { useBrowserDefaults } from "~/browser/browserDefaults";
import {
  normalizeDotChatUrl,
  readDotChatTarget,
  useDotChatStore,
  type DotChatTarget,
} from "~/dotChatStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function DotChatSetup({
  environmentId,
  suggestedTarget,
  onSaved,
}: {
  environmentId: EnvironmentId;
  suggestedTarget?: DotChatTarget | undefined;
  onSaved?: ((target: DotChatTarget) => void) | undefined;
}) {
  const saved = useDotChatStore((state) => state.byEnvironment[environmentId]);
  const target = readDotChatTarget(saved) ?? suggestedTarget;
  const defaults = useBrowserDefaults();
  const [url, setUrl] = useState(target?.url ?? "");
  const [profileId, setProfileId] = useState(target?.profileId ?? defaults.profileId);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const urlId = useId();
  const profiles = defaults.profiles.filter((profile) => profile.kind !== "incognito");
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = normalizeDotChatUrl(url);
        if (!normalized || !selectedProfile) {
          setError(
            !normalized
              ? "Paste your Dot conversation link from ChatGPT (https://chatgpt.com/dots/…)."
              : "Choose an available browser profile.",
          );
          return;
        }
        const next = { url: normalized, profileId };
        useDotChatStore.getState().setTarget(environmentId, next);
        setError(null);
        setSavedNotice(true);
        onSaved?.(next);
      }}
    >
      <p className="text-sm text-muted-foreground">
        Chat with your existing Dot directly. Your conversation and memory stay in ChatGPT; J1
        workers are optional.
      </p>
      <label htmlFor={urlId} className="text-sm font-medium">
        Dot conversation URL
      </label>
      <Input
        id={urlId}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://chatgpt.com/dots/…"
      />
      <span className="text-sm font-medium">ChatGPT browser profile</span>
      <Select
        value={profileId}
        onValueChange={(value) => {
          if (value) setProfileId(value);
        }}
      >
        <SelectTrigger aria-label="ChatGPT browser profile">
          <SelectValue>{selectedProfile?.name ?? "Choose a profile"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {profiles.map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>
              {profile.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <p className="text-xs text-muted-foreground">
        Use the profile where you signed in to ChatGPT. The embedded chat is available in J1
        desktop. In a web client, open the saved link in ChatGPT; on mobile, use ChatGPT directly.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {savedNotice && !onSaved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Dot chat saved.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm">
          {onSaved ? "Save and open Dot" : "Save Dot chat"}
        </Button>
        {saved ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              useDotChatStore.getState().setTarget(environmentId, null);
              setUrl("");
              setSavedNotice(false);
            }}
          >
            Forget link
          </Button>
        ) : null}
      </div>
    </form>
  );
}
