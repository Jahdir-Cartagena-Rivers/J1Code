import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@j1code/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  type ProjectMutation,
  WS_METHODS,
} from "@j1code/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { randomUUID } from "../../lib/utils";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const listFolders = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "project-tracked-folders",
  tag: WS_METHODS.workspaceListFolders,
});

const updateFolders = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "project-tracked-folders:update",
  tag: WS_METHODS.projectsMutate,
});

type FolderEdit = Pick<
  Extract<ProjectMutation, { type: "project.update" }>,
  "trackFolders" | "untrackFolders"
>;

function CheckoutFolders({ checkout }: { readonly checkout: SidebarProjectGroupMember }) {
  const atom = listFolders({
    environmentId: checkout.environmentId,
    input: { projectId: checkout.id },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const canEdit = useEnvironmentScope(checkout.environmentId, AuthOrchestrationOperateScope);
  const save = useOrchestrationCommand(updateFolders, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const folders = AsyncResult.getOrElse(result, () => null)?.folders ?? [];

  async function submit(edit: FolderEdit) {
    setPending(true);
    setError(null);
    try {
      const saved = await save({
        environmentId: checkout.environmentId,
        input: {
          type: "project.update",
          commandId: CommandId.make(randomUUID()),
          projectId: checkout.id,
          ...edit,
        },
      });
      if (saved._tag === "Failure") {
        const cause = Cause.squash(saved.cause);
        setError(cause instanceof Error ? cause.message : "Could not save project folders.");
        return;
      }
      setPath("");
      setName("");
      refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsSection title={checkout.workspaceRoot} variant="plain">
      {result._tag === "Failure" && (
        <SettingsRow
          title="Could not load project folders"
          control={
            <Button type="button" size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      )}
      {result._tag === "Initial" && <SettingsRow title="Loading project folders…" />}
      {folders.map((folder) => (
        <SettingsRow
          key={folder.path}
          title={folder.name}
          description={`${folder.path}${folder.state === "missing" ? " (missing)" : ""}`}
          control={
            folder.discovered ? (
              "Discovered"
            ) : canEdit ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void submit({ untrackFolders: [folder.path] })}
                aria-label={`Remove ${folder.name}`}
              >
                Remove
              </Button>
            ) : undefined
          }
        />
      ))}
      {canEdit && (
        <form
          className="flex flex-wrap items-center gap-2 px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending && path.trim() && name.trim())
              void submit({ trackFolders: [{ path: path.trim(), name: name.trim() }] });
          }}
        >
          <Input
            value={name}
            size="sm"
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={128}
            aria-label="Folder name"
            placeholder="Folder name"
          />
          <Input
            value={path}
            size="sm"
            onChange={(event) => setPath(event.currentTarget.value)}
            aria-label="Absolute folder path"
            placeholder="Absolute folder path"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={pending || !path.trim() || !name.trim()}
          >
            Add folder
          </Button>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
    </SettingsSection>
  );
}

function ReadableCheckoutFolders({ checkout }: { readonly checkout: SidebarProjectGroupMember }) {
  const canRead = useEnvironmentScope(checkout.environmentId, AuthFilesystemReadScope);
  return canRead ? <CheckoutFolders checkout={checkout} /> : null;
}

export function ProjectFoldersSettings({
  checkouts,
}: {
  readonly checkouts: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  return (
    <SettingsSection title="Tracked folders" variant="plain">
      {checkouts.map((checkout) => (
        <ReadableCheckoutFolders
          key={`${checkout.environmentId}:${checkout.id}`}
          checkout={checkout}
        />
      ))}
    </SettingsSection>
  );
}
