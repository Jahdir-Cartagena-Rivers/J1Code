import { assert, describe, it } from "vite-plus/test";

import { getProjectFilePickerMatches, groupMatchRanges } from "./ProjectFilePicker.logic";

function pathsForQuery(entries: Parameters<typeof getProjectFilePickerMatches>[0], query: string) {
  return getProjectFilePickerMatches(entries, query).map(({ name, path }) => ({ name, path }));
}

describe("getProjectFilePickerMatches", () => {
  it("matches ordered characters while allowing skipped characters", () => {
    const fuzzyEntries = [
      { kind: "file", path: "src/TestFlags.tsx" },
      { kind: "file", path: "src/SubtestFlow.tsx" },
      { kind: "file", path: "src/useSubtestFlags.ts" },
      {
        kind: "file",
        path: "src/useSubtestFlags/useTabActivity.ts",
      },
    ] as const;

    assert.deepEqual(
      pathsForQuery(fuzzyEntries, "testf").map(({ name }) => name),
      ["TestFlags.tsx", "SubtestFlow.tsx", "useSubtestFlags.ts", "useTabActivity.ts"],
    );
    assert.deepEqual(getProjectFilePickerMatches(fuzzyEntries, "tsfl")[0], {
      name: "TestFlags.tsx",
      nameMatchIndices: [0, 2, 4, 5],
      path: "src/TestFlags.tsx",
      pathMatchIndices: [4, 6, 8, 9],
    });
  });

  it("normalizes path prefixes consistently with server search", () => {
    assert.deepEqual(
      getProjectFilePickerMatches([{ kind: "file", path: "src/index.ts" }], "@/src")[0]
        ?.pathMatchIndices,
      [0, 1, 2],
    );
  });

  it("keeps highlights on source characters when Unicode case folding expands their length", () => {
    const entries = [{ kind: "file", path: "İ/İ😀.ts" }] as const;
    const [match] = getProjectFilePickerMatches(entries, "😀t");
    assert.deepEqual(match?.nameMatchIndices, [1, 2, 4]);
    assert.deepEqual(match?.pathMatchIndices, [3, 4, 6]);
    assert.deepEqual(groupMatchRanges(match!.nameMatchIndices), [
      [1, 3],
      [4, 5],
    ]);
  });
});
