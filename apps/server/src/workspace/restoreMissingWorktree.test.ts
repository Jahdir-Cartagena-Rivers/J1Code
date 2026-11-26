import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makePrepareTerminalLaunch } from "./restoreMissingWorktree.ts";

it.effect("prepares only the requested saved thread and still accepts an unsaved draft", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const input = { threadId: "requested", terminalId: "terminal", cwd: path.resolve("fixture") };
    const owned = {
      id: ThreadId.make(input.threadId),
      projectId: ProjectId.make("project"),
      worktreePath: input.cwd,
      branch: "fixture",
      deletedAt: null,
    };
    for (const lookup of [
      Effect.fail("unavailable"),
      Effect.succeed({ ...owned, id: ThreadId.make("other-thread") }),
      Effect.succeed({ ...owned, deletedAt: DateTime.makeUnsafe(1) }),
    ]) {
      const prepare = yield* makePrepareTerminalLaunch((id) => {
        expect(id).toBe(owned.id);
        return lookup;
      });
      const refusal = yield* prepare(input).pipe(Effect.flip);
      expect(refusal).toMatchObject({
        _tag: "TerminalSessionLookupError",
        threadId: input.threadId,
        terminalId: input.terminalId,
      });
    }

    const prepareOwned = yield* makePrepareTerminalLaunch(() => Effect.succeed(owned));
    expect((yield* prepareOwned(input)).input).toEqual({ ...input, worktreePath: input.cwd });
    const prepareDraft = yield* makePrepareTerminalLaunch(() => Effect.succeed(null));
    expect((yield* prepareDraft(input)).input).toEqual(input);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ServerSettings.layerTest(),
        Layer.mock(ServerConfig.ServerConfig)({}),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
      ),
    ),
  ),
);
