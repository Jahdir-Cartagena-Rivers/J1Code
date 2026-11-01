import type { HomeProjectScope } from "./homeThreadList";
import { threadListV2ListItemsAreEqual, type ThreadListV2ListItem } from "../threads/threadListV2";
import { scopedProjectKey } from "../../lib/scopedEntities";

export type GroupedHomeListItem =
  | ThreadListV2ListItem
  | {
      readonly type: "project-heading";
      readonly key: string;
      readonly scopeKey: string;
      readonly title: string;
      readonly count: number;
      readonly expanded: boolean;
    };

// Keep shelf boundaries intact while grouping each section by logical project.
export function groupHomeList(input: {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly collapsedKeys: ReadonlySet<string>;
  readonly searching: boolean;
}): GroupedHomeListItem[] {
  const scopeByProject = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (ref) => [scopedProjectKey(ref.environmentId, ref.projectId), scope.key] as const,
      ),
    ),
  );
  const result: GroupedHomeListItem[] = [];
  let section = "active";
  let rows: ThreadListV2ListItem[] = [];
  const flush = () => {
    const buckets = new Map<string, ThreadListV2ListItem[]>();
    const unmatched: ThreadListV2ListItem[] = [];
    for (const row of rows) {
      const entity =
        row.type === "v2-thread"
          ? row.item.thread
          : row.type === "v2-pending"
            ? row.pendingTask
            : null;
      const scopeKey =
        entity && scopeByProject.get(scopedProjectKey(entity.environmentId, entity.projectId));
      if (!scopeKey) {
        unmatched.push(row);
        continue;
      }
      const bucket = buckets.get(scopeKey) ?? [];
      bucket.push(row);
      buckets.set(scopeKey, bucket);
    }
    for (const scope of input.scopes) {
      const bucket = buckets.get(scope.key);
      // The active section is also the project organizer. Keep an empty
      // heading there so a project can be moved before it has any chats.
      if (!bucket?.length && (section !== "active" || input.searching)) continue;
      const expanded = input.searching || !input.collapsedKeys.has(scope.key);
      result.push({
        type: "project-heading",
        key: `project:${section}:${scope.key}`,
        scopeKey: scope.key,
        title: scope.title,
        count: bucket?.length ?? 0,
        expanded,
      });
      if (expanded && bucket) result.push(...bucket);
    }
    result.push(...unmatched);
    rows = [];
  };
  for (const item of input.items) {
    if (item.type === "v2-snoozed-shelf" || item.type === "v2-settled-shelf") {
      flush();
      section = item.key;
      result.push(item);
    } else rows.push(item);
  }
  flush();
  return result;
}

export function groupedHomeItemsAreEqual(previous: GroupedHomeListItem, item: GroupedHomeListItem) {
  if (item.type === "project-heading")
    return (
      previous.type === "project-heading" &&
      previous.key === item.key &&
      previous.title === item.title &&
      previous.count === item.count &&
      previous.expanded === item.expanded
    );
  return previous.type !== "project-heading" && threadListV2ListItemsAreEqual(previous, item);
}
