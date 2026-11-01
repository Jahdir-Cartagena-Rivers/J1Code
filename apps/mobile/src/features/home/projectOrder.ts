/** Reorder visible projects without moving hidden projects out of their saved slots. */
export function moveVisibleProjects(
  saved: readonly string[],
  visible: readonly string[],
  from: number,
  to: number,
): string[] {
  const visibleSet = new Set(visible);
  const base = [...new Set([...saved, ...visible])];
  if (from < 0 || to < 0 || from >= visible.length || to >= visible.length || from === to)
    return base;
  const reordered = [...visible];
  const [moved] = reordered.splice(from, 1);
  if (moved === undefined) return base;
  reordered.splice(to, 0, moved);
  let index = 0;
  return base.map((key) => (visibleSet.has(key) ? reordered[index++]! : key));
}
