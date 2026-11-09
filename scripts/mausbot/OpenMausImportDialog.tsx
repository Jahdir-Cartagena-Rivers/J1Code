import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { WorkspaceBackupSettings } from "./WorkspaceBackupSettings";

/** Uses the workspace restore transaction, including preview, safety copy and restart recovery. */
export function OpenMausImportDialog({ onClose }: { onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        ref={root}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="openmaus-import-title"
        data-openmaus-import=""
        className="ui-modal flex max-h-[calc(100dvh-32px)] w-[640px] max-w-full flex-col overflow-hidden text-left outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key !== "Tab") return;
          const controls = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), a[href]",
            ) ?? []),
          ];
          const index = controls.indexOf(document.activeElement as HTMLElement);
          if (
            index < 0 ||
            (event.shiftKey && index === 0) ||
            (!event.shiftKey && index === controls.length - 1)
          ) {
            event.preventDefault();
            controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
          }
        }}
      >
        <div className="flex items-center justify-between p-4">
          <h2 id="openmaus-import-title" className="text-[15px] font-semibold">
            Import from OpenMaus
          </h2>
          <button type="button" aria-label="Close" className="ui-icon-button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <p className="mb-3 text-[13px] leading-relaxed text-ink-secondary">
            In OpenMaus, open Settings → Backups and export your workspace. Choose that .ombbackup
            file below and enter its password to preview your bots, conversations, memories,
            routines, and files. Your original OpenMaus workspace stays intact.
          </p>
          <p className="mb-4 text-[13px] leading-relaxed text-ink-secondary">
            This restores the bot workspace on this J1 server. Review the replacement warning and
            exclusions before confirming. Existing J1 projects and coding chats are separate. After
            importing, restart J1 Code to finish.
          </p>
          <WorkspaceBackupSettings importOnly />
        </div>
      </div>
    </div>
  );
}
