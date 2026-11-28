import type { ServerProviderSkill } from "@j1code/contracts";
import { scoreQueryMatch } from "@j1code/shared/searchRanking";

export function scoreSlashSkillQuery(skill: ServerProviderSkill, query: string): number | null {
  if (!skill.enabled) return null;
  const normalizedQuery = query.toLowerCase();
  const skillQuery =
    normalizedQuery === "skill"
      ? ""
      : normalizedQuery.startsWith("skill:")
        ? normalizedQuery.slice("skill:".length)
        : normalizedQuery;
  return skillQuery ? scoreSkillQuery(skill, skillQuery, false) : 0;
}

export function scoreSkillQuery(skill: ServerProviderSkill, query: string, fuzzy: boolean) {
  const scores = [
    scoreQueryMatch({
      value: skill.name.toLowerCase(),
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      ...(fuzzy ? { fuzzyBase: 100 } : {}),
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: (skill.displayName ?? skill.name).toLowerCase(),
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 5,
      includesBase: 7,
      ...(fuzzy ? { fuzzyBase: 110 } : {}),
    }),
    scoreQueryMatch({
      value: skill.shortDescription?.toLowerCase() ?? "",
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
    scoreQueryMatch({
      value: skill.description?.toLowerCase() ?? "",
      query,
      exactBase: 30,
      prefixBase: 32,
      boundaryBase: 34,
      includesBase: 36,
    }),
  ].filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
}
