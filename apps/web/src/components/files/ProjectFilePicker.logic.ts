import type { ProjectEntry } from "@j1code/contracts";
import { normalizeSearchQuery } from "@j1code/shared/searchRanking";

export const PROJECT_FILE_PICKER_RESULT_LIMIT = 200;

export interface ProjectFilePickerMatch {
  readonly name: string;
  readonly nameMatchIndices: ReadonlyArray<number>;
  readonly path: string;
  readonly pathMatchIndices: ReadonlyArray<number>;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Return null for unmatched subsequences; server-matched entries still render without highlights. */
function findMatchIndices(value: string, query: ReadonlyArray<string>): number[] | null {
  if (query.length === 0) return [];

  // Whole-string lowercasing preserves the contextual form of Greek final sigma.
  const normalizedValue = value.toLowerCase();
  const sourceSpans: Array<readonly [number, number]> = [];
  if (normalizedValue.length !== value.length) {
    let sourceOffset = 0;
    for (const char of value) {
      const end = sourceOffset + char.length;
      for (const _ of char.toLowerCase()) sourceSpans.push([sourceOffset, end]);
      sourceOffset = end;
    }
  }
  const indices: number[] = [];
  let queryIndex = 0;
  let sourceOffset = 0;
  let charIndex = 0;

  for (const char of normalizedValue) {
    if (char === query[queryIndex]) {
      const [start, end] = sourceSpans[charIndex] ?? [sourceOffset, sourceOffset + char.length];
      for (let index = Math.max(start, (indices.at(-1) ?? -1) + 1); index < end; index += 1) {
        indices.push(index);
      }
      queryIndex += 1;
      if (queryIndex === query.length) return indices;
    }
    sourceOffset += char.length;
    charIndex += 1;
  }

  return null;
}

export function groupMatchRanges(
  indices: ReadonlyArray<number>,
): Array<readonly [start: number, end: number]> {
  const ranges: Array<[number, number]> = [];
  for (const index of indices) {
    const previous = ranges.at(-1);
    if (previous && previous[1] === index) {
      previous[1] = index + 1;
    } else {
      ranges.push([index, index + 1]);
    }
  }
  return ranges;
}

/** Preserve server ranking and query normalization while filtering files and computing highlights. */
export function getProjectFilePickerMatches(
  entries: ReadonlyArray<ProjectEntry>,
  rawQuery: string,
  limit = PROJECT_FILE_PICKER_RESULT_LIMIT,
): ProjectFilePickerMatch[] {
  if (limit <= 0) return [];

  const query = Array.from(
    normalizeSearchQuery(rawQuery, { trimLeadingPattern: /^[@./]+/ }).replaceAll(/\s/g, ""),
  );
  const matches: ProjectFilePickerMatch[] = [];

  for (const entry of entries) {
    if (entry.kind !== "file") continue;

    const name = fileName(entry.path);
    const nameMatchIndices = findMatchIndices(name, query);
    const pathMatchIndices = findMatchIndices(entry.path, query);
    matches.push({
      name,
      nameMatchIndices: nameMatchIndices ?? [],
      path: entry.path,
      pathMatchIndices: pathMatchIndices ?? [],
    });
    if (matches.length >= limit) break;
  }

  return matches;
}
