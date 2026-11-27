import { expect, it } from "vite-plus/test";
import { collapsedTimelineCommentMarkdown } from "./PullRequestTimeline.logic";

it("keeps a complete emoji at the collapsed preview boundary", () => {
  const prefix = "a".repeat(1198);
  expect(collapsedTimelineCommentMarkdown(`${prefix}😀 trailing`)).toBe(`${prefix}😀`);
  expect(collapsedTimelineCommentMarkdown(`${prefix}a😀 trailing`)).toBe(`${prefix}a`);
});
