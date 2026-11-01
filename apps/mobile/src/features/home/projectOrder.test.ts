import { expect, it } from "vite-plus/test";
import { moveVisibleProjects } from "./projectOrder";
it("keeps hidden projects in their saved slots while reordering the visible subset", () => {
  expect(moveVisibleProjects(["a", "hidden", "b", "other"], ["a", "b"], 1, 0)).toEqual([
    "b",
    "hidden",
    "a",
    "other",
  ]);
});
it("includes newly visible projects and rejects an invalid move", () => {
  expect(moveVisibleProjects(["a", "hidden"], ["a", "b"], 1, 0)).toEqual(["b", "hidden", "a"]);
  expect(moveVisibleProjects(["a"], ["a", "b"], -1, 0)).toEqual(["a", "b"]);
});
