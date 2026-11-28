import { assert, it } from "@effect/vitest";
import { ProjectId, type PullRequestActionInput } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as WorkflowForge from "./WorkflowForge.ts";

it.effect(
  "resolves Windows project folders and sends only a valid pull request to the normal action service",
  () => {
    const projectId = ProjectId.make("project-workflow");
    const project = "C:/projects/app";
    const actions: PullRequestActionInput[] = [];
    const layer = WorkflowForge.layerPullRequests.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getByWorkspaceRoot: (root) => {
              assert.strictEqual(root, project);
              return Effect.succeedSome({ id: projectId } as never);
            },
          }),
          Layer.mock(PullRequestService.PullRequestService)({
            runAction: (input) =>
              Effect.sync(() => {
                actions.push(input);
                return undefined;
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const { pullRequests } = yield* WorkflowForge.WorkflowForge;
      yield* pullRequests.act({ project, url: "https://github.com/Owner/App/pull/7" }, "merge", {
        mergeMethod: "squash",
      });
      const denied = yield* Effect.flip(
        pullRequests.act({ project, url: "https://github.com/Owner/App/issues/7" }, "merge"),
      );
      assert.strictEqual(denied.reason, "Expected a pull request URL.");
      assert.deepStrictEqual(actions, [
        {
          projectId,
          host: "github.com",
          repository: "owner/app",
          number: 7,
          action: "merge",
          mergeMethod: "squash",
        },
      ]);
    }).pipe(Effect.provide(layer));
  },
);
