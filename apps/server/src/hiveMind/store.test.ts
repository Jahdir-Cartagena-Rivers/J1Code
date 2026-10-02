// @effect-diagnostics nodeBuiltinImport:off - tests isolated persistence using a temporary Node filesystem directory.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "@effect/vitest";
import {
  forgetHiveFact,
  hiveContext,
  importHiveFacts,
  readHiveMind,
  recallHiveFacts,
  rememberHiveFact,
} from "./store.ts";

describe("Hive Mind", () => {
  it("shares general facts across project searches and replaces corrections", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-mind-"));
    const file = NodePath.join(directory, "hive-mind.json");
    try {
      const first = await rememberHiveFact(file, {
        scope: "general",
        project: null,
        subject: "Nebula",
        fact: "A user-created character",
        sourceThreadId: "thread-a",
      });
      NodeAssert.equal((await recallHiveFacts(file, "Nebula", "Sample Videos"))[0]?.id, first.id);
      const correction = await rememberHiveFact(file, {
        scope: "general",
        project: null,
        subject: "nebula",
        fact: "A revised description",
        sourceThreadId: "thread-b",
      });
      NodeAssert.equal(correction.id, first.id);
      NodeAssert.equal((await readHiveMind(file)).memories.length, 1);
      NodeAssert.equal((await recallHiveFacts(file, "Nebula"))[0]?.fact, "A revised description");
      NodeAssert.match(
        hiveContext(file, "Use Nebula in Sample Videos"),
        /Nebula.*A revised description/,
      );
      NodeAssert.equal(await forgetHiveFact(file, first.id), true);
      NodeAssert.deepEqual(await recallHiveFacts(file, "Nebula"), []);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown versions without overwriting them", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-mind-"));
    const file = NodePath.join(directory, "hive-mind.json");
    try {
      const original = '{"version":2,"memories":[]}';
      await NodeFSP.writeFile(file, original);
      await NodeAssert.rejects(() =>
        rememberHiveFact(file, {
          scope: "general",
          project: null,
          subject: "Test",
          fact: "Test",
          sourceThreadId: "thread",
        }),
      );
      NodeAssert.equal(await NodeFSP.readFile(file, "utf8"), original);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("reimports unchanged notes safely and protects later user corrections", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-mind-"));
    const file = NodePath.join(directory, "hive-mind.json");
    const native = {
      scope: "general" as const,
      project: null,
      subject: "Codex / profile / Preference 1",
      fact: "Prefers concise updates",
      sourceThreadId: "import:codex:MEMORY.md:profile:preferences:1",
    };
    try {
      const first = await importHiveFacts(file, [native], 1);
      NodeAssert.equal(first.created, 1);
      const repeated = await importHiveFacts(file, [native], 1);
      NodeAssert.equal(repeated.unchanged, 1);
      await rememberHiveFact(file, {
        ...native,
        fact: "Prefers detailed updates",
        sourceThreadId: "thread-correction",
      });
      const protectedResult = await importHiveFacts(file, [native], 1);
      NodeAssert.equal(protectedResult.protected, 1);
      NodeAssert.equal((await readHiveMind(file)).memories[0]?.fact, "Prefers detailed updates");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates normalized import subjects without crossing projects or replacing corrections", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-mind-"));
    const file = NodePath.join(directory, "hive-mind.json");
    try {
      const native = {
        scope: "project" as const,
        project: "SampleApp",
        subject: "Build settings",
        fact: "Original note",
        sourceThreadId: "import:example:build",
      };
      const result = await importHiveFacts(
        file,
        [
          native,
          { ...native, project: " sampleapp ", subject: " BUILD SETTINGS ", fact: "Updated note" },
          { ...native, project: "OtherApp" },
          {
            ...native,
            project: "SAMPLEAPP",
            sourceThreadId: "import:other:build",
            fact: "Untrusted replacement",
          },
        ],
        2,
      );
      NodeAssert.deepEqual(result, {
        sources: 2,
        created: 2,
        updated: 1,
        unchanged: 0,
        protected: 1,
      });
      const data = await readHiveMind(file);
      NodeAssert.equal(data.memories.length, 2);
      NodeAssert.equal(data.memories[0]?.fact, "Updated note");
      NodeAssert.equal(data.memories[1]?.project, "OtherApp");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("selects a named concept from another project before broad profile notes", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-mind-"));
    const file = NodePath.join(directory, "hive-mind.json");
    try {
      const broad = Array.from({ length: 12 }, (_, index) => ({
        scope: "general" as const,
        project: null,
        subject: `General preference ${index}`,
        fact: `Unrelated preference ${index}: ${"x".repeat(260)}`,
        sourceThreadId: `import:codex:MEMORY.md:general:${index}`,
      }));
      await importHiveFacts(
        file,
        [
          ...broad,
          {
            scope: "project",
            project: "SampleApp",
            subject: "Nebula",
            fact: "Nebula is a reusable character concept.",
            sourceThreadId: "import:claude:SampleApp/nebula.md",
          },
          {
            scope: "general",
            project: null,
            subject: "Claude.ai account memory / Nebula",
            fact: "The user also discusses Nebula across projects.",
            sourceThreadId: "import:claude-account:section-1:1",
          },
        ],
        2,
      );
      NodeAssert.match(
        (await recallHiveFacts(file, "Nebula in Sample Videos", "Sample Videos", 1))[0]
          ?.sourceThreadId ?? "",
        /^import:claude-account:/u,
      );
      NodeAssert.match(
        hiveContext(file, "Use Nebula in Sample Videos"),
        /Nebula is a reusable character concept/,
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
