import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  foldWorkerChat,
  createWorkerChatLookup,
  getRootChats,
  reconcileWorkerChatExpansion,
  toggleWorkerChats,
  unfoldWorkerChat,
  workerChatKey,
} from "@t3tools/client-runtime/worker-chats";
import { ChevronDown, ChevronRight, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import { useWorkerChatStore } from "~/workerChatStore";
import { useThreadSelectionStore } from "~/threadSelectionStore";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { useSidebar } from "./ui/sidebar";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";

const EMPTY_ANCESTORS: readonly string[] = [];
const lookupWorkerChats = createWorkerChatLookup<EnvironmentThreadShell>();
type WorkerFileDrop = (threadRef: ScopedThreadRef, files: File[]) => void;

export function useRootChatShells() {
  const threads = useThreadShells();
  return useMemo(() => getRootChats(threads), [threads]);
}

function useWorkerChats(parent: ScopedThreadRef) {
  const threads = useThreadShells();
  const children = useMemo(
    () =>
      lookupWorkerChats(threads, {
        environmentId: parent.environmentId,
        id: parent.threadId,
      }),
    [parent.environmentId, parent.threadId, threads],
  );
  const key = workerChatKey({ environmentId: parent.environmentId, id: parent.threadId });
  const previous = useWorkerChatStore((state) => state.byParentKey[key]);
  const setExpansion = useWorkerChatStore((state) => state.setExpansion);
  const expansion = useMemo(
    () =>
      reconcileWorkerChatExpansion(
        previous,
        children.map((child) => child.id),
      ),
    [children, previous],
  );
  useEffect(() => {
    if (children.length > 0 && expansion !== previous) setExpansion(key, expansion);
  }, [children.length, expansion, key, previous, setExpansion]);
  return { children, expansion, update: (next: typeof expansion) => setExpansion(key, next) };
}

function WorkerChatLink({
  thread,
  onFileDropThreads,
}: {
  thread: EnvironmentThreadShell;
  onFileDropThreads?: WorkerFileDrop | undefined;
}) {
  const { setOpenMobile } = useSidebar();
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) =>
          onFileDropThreads?.({ environmentId: thread.environmentId, threadId: thread.id }, files),
        addFolders: () => {},
      }),
    [onFileDropThreads, thread.environmentId, thread.id],
  );
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[workerChatKey(thread)],
  );
  const status = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams({ environmentId: thread.environmentId, threadId: thread.id })}
      aria-label={thread.title}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        clearSelection();
        setAnchor(workerChatKey(thread));
        setOpenMobile(false);
      }}
      onDragEnter={(event) => {
        event.stopPropagation();
        fileDropHandlers.onDragEnter(event);
      }}
      onDragOver={(event) => {
        event.stopPropagation();
        fileDropHandlers.onDragOver(event);
      }}
      onDragLeave={(event) => {
        event.stopPropagation();
        fileDropHandlers.onDragLeave(event);
      }}
      onDrop={(event) => {
        event.stopPropagation();
        fileDropHandlers.onDrop(event);
      }}
      activeProps={{
        "aria-current": "page",
        className: "bg-sidebar-row-active text-sidebar-foreground",
      }}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        isFileDragOver && "ring-1 ring-inset ring-primary/70",
      )}
    >
      {status ? (
        <span
          aria-label={status.label}
          className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)}
        />
      ) : null}
      <span className="truncate">{thread.title.replace(/^Worker:\s*/, "")}</span>
    </Link>
  );
}

/** Compact connector rails belong to the worker feature, not the generic sidebar primitives. */
export function WorkerChatTree({
  parent,
  ancestors = EMPTY_ANCESTORS,
  onFileDropThreads,
}: {
  parent: ScopedThreadRef;
  ancestors?: readonly string[];
  onFileDropThreads?: WorkerFileDrop | undefined;
}) {
  const enabled = useClientSettings((settings) => settings.workerChatsInSidebar);
  const { children, expansion, update } = useWorkerChats(parent);
  const key = workerChatKey({ environmentId: parent.environmentId, id: parent.threadId });
  if (!enabled || children.length === 0 || ancestors.includes(key)) return null;
  const visible = expansion.folded
    ? []
    : children.filter((child) => expansion.unfoldedIds.includes(child.id));
  const folded = visible.length === 0;
  return (
    <div
      data-thread-selection-safe
      className="ml-2 min-w-0"
      onPointerDown={(event) => event.stopPropagation()}
      onDragEnter={(event) => event.stopPropagation()}
      onDragOver={(event) => event.stopPropagation()}
      onDragLeave={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={`${folded ? "Unfold" : "Fold"} worker chats`}
        aria-expanded={!folded}
        onClick={() => update(toggleWorkerChats({ ...expansion, folded }))}
        className="flex h-6 cursor-pointer items-center gap-1 rounded px-1 text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {folded ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        <span>Workers ({children.length})</span>
        {!folded && children.length > visible.length ? (
          <span>· {children.length - visible.length} folded</span>
        ) : null}
      </button>
      {visible.length > 0 ? (
        <ul role="presentation" className="ml-1.5">
          {visible.map((child, index) => (
            <li key={child.id} className="relative min-w-0 pl-3">
              <span
                aria-hidden
                className={cn(
                  "absolute top-0 left-0 w-3 border-l border-border/70",
                  index === visible.length - 1 ? "h-3.5 rounded-bl-md border-b" : "h-full",
                )}
              />
              {index < visible.length - 1 ? (
                <span
                  aria-hidden
                  className="absolute top-0 left-0 h-3.5 w-3 rounded-bl-md border-b border-border/70"
                />
              ) : null}
              <div className="group/worker flex min-w-0 items-center">
                <WorkerChatLink thread={child} onFileDropThreads={onFileDropThreads} />
                <button
                  type="button"
                  aria-label={`Fold ${child.title} into parent chat`}
                  onClick={() => update(foldWorkerChat(expansion, child.id))}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Minus className="size-3" />
                </button>
              </div>
              <WorkerChatTree
                parent={{ environmentId: child.environmentId, threadId: child.id }}
                ancestors={[...ancestors, key]}
                onFileDropThreads={onFileDropThreads}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** All saved workers remain reachable here, independent of sidebar presentation. */
export function WorkerChatsInChat({ parent }: { parent: ScopedThreadRef }) {
  const threads = useThreadShells();
  const enabled = useClientSettings((settings) => settings.workerChatsInSidebar);
  const { children, expansion, update } = useWorkerChats(parent);
  const shell = threads.find(
    (thread) => thread.environmentId === parent.environmentId && thread.id === parent.threadId,
  );
  const lead = threads.find(
    (thread) =>
      thread.environmentId === parent.environmentId && thread.id === shell?.parentThreadId,
  );
  if (children.length === 0 && !lead) return null;
  return (
    <div className="shrink-0 border-b border-border/60 px-3 py-1.5 text-xs">
      {lead ? (
        <div className="flex items-center gap-1 text-muted-foreground">
          <span>Parent chat:</span>
          <WorkerChatLink thread={lead} />
        </div>
      ) : null}
      {children.length > 0 ? (
        <details>
          <summary className="cursor-pointer rounded py-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Worker chats ({children.length})
          </summary>
          <ul role="presentation" className="max-h-48 overflow-y-auto py-1">
            {children.toReversed().map((child) => {
              const unfolded = !expansion.folded && expansion.unfoldedIds.includes(child.id);
              return (
                <li key={child.id} className="flex items-center gap-2">
                  <WorkerChatLink thread={child} />
                  {enabled ? (
                    <button
                      type="button"
                      onClick={() =>
                        update(
                          unfolded
                            ? foldWorkerChat(expansion, child.id)
                            : unfoldWorkerChat(expansion, child.id),
                        )
                      }
                      aria-label={`${unfolded ? "Fold" : "Unfold"} ${child.title} in sidebar`}
                      className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {unfolded ? <Minus className="size-3" /> : <Plus className="size-3" />}
                      {unfolded ? "Fold" : "Unfold"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
