import { useRef, useState } from "react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import {
  useDotChatStore,
  readDotChatTarget,
  normalizeDotChatUrl,
  type DotChatTarget,
} from "~/dotChatStore";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { isPreviewSupportedInRuntime, readThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { openPreviewSession } from "../preview/openPreviewSession";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { DotChatSetup } from "./DotChatSetup";

export function DotChatControl({
  threadRef,
  active,
  onOpened,
  onReturn,
}: {
  threadRef: ScopedThreadRef;
  active: boolean;
  onOpened: (tabId: string) => void;
  onReturn: () => void;
}) {
  const saved = useDotChatStore((state) => state.byEnvironment[threadRef.environmentId]);
  const target = readDotChatTarget(saved);
  const defaults = useBrowserDefaults();
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const opening = useRef(false);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const sessions = Object.values(readThreadPreviewState(threadRef).sessions);
  const suggested = sessions.find(
    (session) => session.navStatus._tag !== "Idle" && normalizeDotChatUrl(session.navStatus.url),
  );
  const suggestedTarget =
    suggested && suggested.navStatus._tag !== "Idle"
      ? {
          url: suggested.navStatus.url,
          profileId: suggested.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
        }
      : undefined;

  const open = async (next: DotChatTarget) => {
    if (opening.current) return;
    if (!isPreviewSupportedInRuntime()) {
      setSetupOpen(true);
      return;
    }
    if (
      !defaults.profiles.some(
        (profile) => profile.id === next.profileId && profile.kind !== "incognito",
      )
    ) {
      setSetupOpen(true);
      return;
    }
    opening.current = true;
    setBusy(true);
    try {
      // Reuse the same conversation tab without navigating or resending anything.
      const existing = Object.values(readThreadPreviewState(threadRef).sessions).find(
        (session) =>
          session.navStatus._tag !== "Idle" &&
          normalizeDotChatUrl(session.navStatus.url) === next.url &&
          (session.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === next.profileId,
      );
      let tabId = existing?.tabId;
      if (!tabId) {
        const result = await openPreviewSession({
          threadRef,
          openPreview,
          url: next.url,
          profileId: next.profileId,
          viewport: FILL_PREVIEW_VIEWPORT,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        tabId = result.value.tabId;
      }
      useRightPanelStore.getState().openBrowser(threadRef, tabId);
      onOpened(tabId);
      setSetupOpen(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to open Dot",
        description:
          error instanceof Error ? error.message : "The browser could not open. Try again.",
      });
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => {
          if (active) onReturn();
          else if (target) void open(target);
          else setSetupOpen(true);
        }}
      >
        {active ? "Back to J1 chat" : busy ? "Opening Dot…" : "Dot"}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Configure Dot chat"
        onClick={() => setSetupOpen(true)}
      >
        ⋯
      </Button>
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Dot chat</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <DotChatSetup
              key={threadRef.environmentId}
              environmentId={threadRef.environmentId}
              suggestedTarget={suggestedTarget}
              onSaved={
                isPreviewSupportedInRuntime()
                  ? (next) => {
                      void open(next);
                    }
                  : undefined
              }
            />
            {!isPreviewSupportedInRuntime() && target ? (
              <p className="mt-3 text-sm">
                <a
                  href={target.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Open your Dot in ChatGPT
                </a>
              </p>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
