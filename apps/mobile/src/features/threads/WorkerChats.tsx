import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  foldWorkerChat,
  createWorkerChatLookup,
  reconcileWorkerChatExpansion,
  toggleWorkerChats,
  unfoldWorkerChat,
  workerChatKey,
} from "@t3tools/client-runtime/worker-chats";
import { AppText as Text } from "../../components/AppText";
import { useThreadShells } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const EMPTY_ANCESTORS: readonly string[] = [];
const lookupWorkerChats = createWorkerChatLookup<EnvironmentThreadShell>();

function useWorkerChats(parent: ScopedThreadRef) {
  const threads = useThreadShells();
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(result);
  const preferences = loaded ? result.value : null;
  const enabled = preferences?.workerChatsInSidebar !== false;
  const key = workerChatKey({ environmentId: parent.environmentId, id: parent.threadId });
  const children = useMemo(
    () =>
      lookupWorkerChats(threads, {
        environmentId: parent.environmentId,
        id: parent.threadId,
      }),
    [parent.environmentId, parent.threadId, threads],
  );
  const previous = preferences?.workerChatExpansionByParent?.[key];
  const expansion = useMemo(
    () =>
      reconcileWorkerChatExpansion(
        previous,
        children.map((child) => child.id),
      ),
    [children, previous],
  );
  useEffect(() => {
    if (!loaded || children.length === 0 || previous === expansion) return;
    save({
      transform: (current) => ({
        workerChatExpansionByParent: { ...current.workerChatExpansionByParent, [key]: expansion },
      }),
    });
  }, [children.length, expansion, key, loaded, previous, save]);
  return {
    threads,
    children,
    enabled,
    expansion,
    update: (next: typeof expansion) => {
      if (!loaded) return;
      save({
        transform: (current) => ({
          workerChatExpansionByParent: { ...current.workerChatExpansionByParent, [key]: next },
        }),
      });
    },
  };
}

function WorkerLink({
  thread,
  onSelectThread,
}: {
  thread: EnvironmentThreadShell;
  onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const working = thread.session?.status === "running" || thread.session?.status === "starting";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={thread.title}
      onPress={() => onSelectThread(thread)}
      className="min-h-8 flex-1 flex-row items-center gap-1.5 rounded px-2 py-1 active:bg-subtle"
    >
      <View
        className={
          working ? "size-1.5 rounded-full bg-info" : "size-1.5 rounded-full bg-foreground-muted"
        }
      />
      <Text numberOfLines={1} className="flex-1 text-xs text-foreground">
        {thread.title.replace(/^Worker:\s*/, "")}
      </Text>
    </Pressable>
  );
}

export function WorkerChatTree({
  parent,
  onSelectThread,
  ancestors = EMPTY_ANCESTORS,
}: {
  parent: ScopedThreadRef;
  onSelectThread: (thread: EnvironmentThreadShell) => void;
  ancestors?: readonly string[];
}) {
  const { children, enabled, expansion, update } = useWorkerChats(parent);
  const key = workerChatKey({ environmentId: parent.environmentId, id: parent.threadId });
  if (!enabled || children.length === 0 || ancestors.includes(key)) return null;
  const visible = expansion.folded
    ? []
    : children.filter((child) => expansion.unfoldedIds.includes(child.id));
  const folded = visible.length === 0;
  return (
    <View className="mx-3 mb-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${folded ? "Unfold" : "Fold"} worker chats`}
        accessibilityState={{ expanded: !folded }}
        onPress={() => update(toggleWorkerChats({ ...expansion, folded }))}
        className="min-h-8 justify-center px-1"
      >
        <Text className="text-xs text-foreground-muted">
          {folded ? "＋" : "−"} Workers ({children.length})
        </Text>
      </Pressable>
      {visible.map((child, index) => (
        <View key={child.id} className="relative ml-2 pl-3">
          <View
            pointerEvents="none"
            className={`absolute left-0 top-0 w-3 rounded-bl-md border-l border-stroke ${index === visible.length - 1 ? "h-4 border-b" : "h-full"}`}
          />
          {index < visible.length - 1 ? (
            <View
              pointerEvents="none"
              className="absolute left-0 top-0 h-4 w-3 rounded-bl-md border-b border-stroke"
            />
          ) : null}
          <View className="flex-row items-center">
            <WorkerLink thread={child} onSelectThread={onSelectThread} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Fold ${child.title} into parent chat`}
              onPress={() => update(foldWorkerChat(expansion, child.id))}
              className="size-8 items-center justify-center"
            >
              <Text className="text-sm text-foreground-muted">−</Text>
            </Pressable>
          </View>
          <WorkerChatTree
            parent={{ environmentId: child.environmentId, threadId: child.id }}
            onSelectThread={onSelectThread}
            ancestors={[...ancestors, key]}
          />
        </View>
      ))}
    </View>
  );
}

export function WorkerChatsInChat({
  parent,
  onSelectThread,
}: {
  parent: ScopedThreadRef;
  onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { threads, children, enabled, expansion, update } = useWorkerChats(parent);
  const [open, setOpen] = useState(false);
  const shell = threads.find(
    (thread) => thread.environmentId === parent.environmentId && thread.id === parent.threadId,
  );
  const lead = threads.find(
    (thread) =>
      thread.environmentId === parent.environmentId && thread.id === shell?.parentThreadId,
  );
  if (children.length === 0 && !lead) return null;
  // oxlint-disable-next-line unicorn/no-array-reverse -- Hermes lacks toReversed; reverse a copy.
  const newestChildren = [...children].reverse();
  return (
    <View className="border-b border-stroke px-3 py-1">
      {lead ? (
        <View className="flex-row items-center">
          <Text className="text-xs text-foreground-muted">Parent chat:</Text>
          <WorkerLink thread={lead} onSelectThread={onSelectThread} />
        </View>
      ) : null}
      {children.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
            className="min-h-8 justify-center"
          >
            <Text className="text-xs text-foreground-muted">
              {open ? "−" : "＋"} Worker chats ({children.length})
            </Text>
          </Pressable>
          {open ? (
            <ScrollView style={{ maxHeight: 192 }} nestedScrollEnabled>
              {newestChildren.map((child) => {
                const unfolded = !expansion.folded && expansion.unfoldedIds.includes(child.id);
                return (
                  <View key={child.id} className="flex-row items-center">
                    <WorkerLink thread={child} onSelectThread={onSelectThread} />
                    {enabled ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${unfolded ? "Fold" : "Unfold"} ${child.title} in sidebar`}
                        onPress={() =>
                          update(
                            unfolded
                              ? foldWorkerChat(expansion, child.id)
                              : unfoldWorkerChat(expansion, child.id),
                          )
                        }
                        className="min-h-8 justify-center px-2"
                      >
                        <Text className="text-xs text-foreground-muted">
                          {unfolded ? "Fold" : "Unfold"}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
