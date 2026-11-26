import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@j1code/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TriageService from "./TriageService.ts";
import { pickSourceRef } from "./TriageService.ts";

const J1_REPOSITORY = "https://github.com/Jahdir-Cartagena-Rivers/J1Code";
const BRANCH_COMMIT = "b".repeat(40);
const RELEASE_COMMIT = "a".repeat(40);
const TAG_OBJECT = "c".repeat(40);
const J1_BRANCH = `${BRANCH_COMMIT}\trefs/heads/j1-code`;
const RELEASE_REF = `${RELEASE_COMMIT}\trefs/tags/v${packageJson.version}\n`;

it("picks the server's release tag and peels annotated tags", () => {
  assert.deepEqual(pickSourceRef(`${J1_BRANCH}\n${RELEASE_COMMIT}\trefs/tags/v0.1.1\n`, "0.1.1"), {
    ref: "v0.1.1",
    commit: RELEASE_COMMIT,
  });
  assert.deepEqual(
    pickSourceRef(
      `${J1_BRANCH}\n${TAG_OBJECT}\trefs/tags/v0.1.1\n${RELEASE_COMMIT}\trefs/tags/v0.1.1^{}\n`,
      "0.1.1",
    ),
    { ref: "v0.1.1", commit: RELEASE_COMMIT },
  );
});

it("falls back to j1-code and discards unrelated refs and invalid object IDs", () => {
  assert.deepEqual(
    pickSourceRef(`${J1_BRANCH}\ninvalid-object\trefs/tags/v0.1.2-dev\n`, "0.1.2-dev"),
    { ref: "j1-code", commit: BRANCH_COMMIT },
  );
  assert.isUndefined(pickSourceRef(`${BRANCH_COMMIT}\trefs/heads/main\n`, "0.1.1"));
  assert.isUndefined(pickSourceRef("not-an-object\trefs/heads/j1-code\n", "0.1.1"));
});

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-triage-service-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** The service over a stub git that answers each command with `answer`. */
const makeTriage = (
  answer: (command: string) => Effect.Effect<string, GitCommandError> = (command) => {
    if (command === "ls-remote") return Effect.succeed(RELEASE_REF);
    if (command === "config") return Effect.succeed(`${J1_REPOSITORY}.git\n`);
    if (command === "rev-parse") return Effect.succeed(`${RELEASE_COMMIT}\n`);
    return Effect.succeed("");
  },
) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const commands: string[] = [];
    const invocations: Array<ReadonlyArray<string>> = [];
    const triage = yield* Layer.build(TriageService.layer).pipe(
      Effect.map(Context.get(TriageService.TriageService)),
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) => {
          const command = input.args[0] ?? "";
          commands.push(command);
          invocations.push(input.args);
          return answer(command).pipe(
            Effect.map((stdout) => ({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
          );
        },
      }),
    );
    return { triage, commands, invocations };
  });

const readContext = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const sessions = `${config.stateDir}/triage`;
  const [session] = yield* fs.readDirectory(sessions);
  return yield* fs.readFileString(`${sessions}/${session}/context.md`);
});

it.effect("sessions started during a clone share it, and a release tag is looked up once", () =>
  Effect.gen(function* () {
    const fetches = yield* Queue.unbounded<void>();
    const { triage, commands, invocations } = yield* makeTriage((command) =>
      command === "fetch"
        ? Queue.offer(fetches, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed(command === "ls-remote" ? RELEASE_REF : ""),
    );

    yield* triage.prepare({ client: {} });
    yield* triage.prepare({ client: {} });
    yield* Queue.take(fetches);

    assert.deepEqual(
      commands.filter((command) => command === "ls-remote" || command === "init"),
      ["ls-remote", "init"],
    );
    const tag = `refs/tags/v${packageJson.version}`;
    assert.deepInclude(invocations, [
      "ls-remote", J1_REPOSITORY, tag, `${tag}^{}`, "refs/heads/j1-code",
    ]);
    assert.deepInclude(invocations, ["remote", "add", "origin", J1_REPOSITORY]);
    assert.deepInclude(invocations, [
      "fetch", "--depth", "1", "--filter=blob:none", "origin", RELEASE_COMMIT,
    ]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reuses a finished clone without fetching", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(`${config.baseDir}/source/${RELEASE_COMMIT}/.git`, {
      recursive: true,
    });
    const { triage, commands } = yield* makeTriage();

    yield* triage.prepare({ client: {} });

    assert.deepEqual(commands, ["ls-remote", "config", "rev-parse"]);
    assert.include(yield* readContext, "The server cloned the source for its own version");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("still starts triage when the source lookup fails", () =>
  Effect.gen(function* () {
    const { triage } = yield* makeTriage(() =>
      Effect.fail(
        new GitCommandError({
          operation: "TriageService.resolveSourceRef",
          command: "git ls-remote",
          cwd: "/",
          detail: "fixture-credential at /home/fixture-user/private",
        }),
      ),
    );

    const { prompt } = yield* triage.prepare({ client: {} });

    assert.include(prompt, "triage-playbook.md");
    const context = yield* readContext;
    assert.include(context, "Could not look up the J1 Code source.");
    assert.notInclude(context, "fixture-credential");
    assert.notInclude(context, "/home/fixture-user/private");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("does not trust a folder without its own .git, even inside a repo at that commit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(`${config.baseDir}/source/${RELEASE_COMMIT}`, { recursive: true });
    // The stub answers rev-parse with the commit, as a parent repository could.
    const { triage, commands } = yield* makeTriage();

    yield* triage.prepare({ client: {} });

    assert.notInclude(commands, "rev-parse");
    assert.include(yield* readContext, "is not a complete J1 Code checkout");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("leaves a foreign checkout at the expected commit in place and still opens triage", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const directory = `${config.baseDir}/source/${RELEASE_COMMIT}`;
    yield* fs.makeDirectory(`${directory}/.git`, { recursive: true });
    yield* fs.writeFileString(`${directory}/fixture.txt`, "user data");
    const stagingDir = `${config.baseDir}/source-staging`;
    yield* fs.makeDirectory(stagingDir, { recursive: true });
    yield* fs.writeFileString(`${stagingDir}/fixture.txt`, "another checkout");
    const { triage, commands } = yield* makeTriage((command) =>
      Effect.succeed(
        command === "ls-remote"
          ? RELEASE_REF
          : command === "config"
            ? "https://example.invalid/foreign.git\n"
            : `${RELEASE_COMMIT}\n`,
      ),
    );

    const { prompt } = yield* triage.prepare({ client: {} });

    assert.deepEqual(commands, ["ls-remote", "config"]);
    assert.include(prompt, "triage-playbook.md");
    assert.include(yield* readContext, "Leave it in place");
    assert.equal(yield* fs.readFileString(`${directory}/fixture.txt`), "user data");
    assert.equal(yield* fs.readFileString(`${stagingDir}/fixture.txt`), "another checkout");
  }).pipe(Effect.provide(TestLayer)),
);
