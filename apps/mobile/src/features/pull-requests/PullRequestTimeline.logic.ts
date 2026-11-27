export function collapsedTimelineCommentMarkdown(body: string): string {
  return body.slice(0, 1200).replace(/[\uD800-\uDBFF]$/u, "");
}
