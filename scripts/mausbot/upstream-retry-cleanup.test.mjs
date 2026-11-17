// Run with MAUSBOT_REVIEW_REPOSITORY pointing at an official upstream git checkout.
// Fixtures come from the exact shipped pin, never from the checkout's working tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const pin = "d818c28aa80686dc1d7db64ebeffa2a9dc468762";
const repository = process.env.MAUSBOT_REVIEW_REPOSITORY;
test(
  "pinned upstream accepts both patches and releases retry resources",
  { skip: !repository },
  async (t) => {
    const stage = await mkdtemp(join(tmpdir(), "j1-retry-patch-test-"));
    t.after(() => rm(stage, { recursive: true, force: true }));
    const patches = await Promise.all(
      ["e14bffd0-memory-queue.patch", "ba3c2b7c-retry-cleanup.patch"].map((name) =>
        readFile(new URL(`./upstream/${name}`, import.meta.url), "utf8"),
      ),
    );
    const files = new Set(["shared/provider-safety.ts"]);
    for (const patch of patches) {
      for (const match of patch.matchAll(/^--- a\/(.+)$/gm)) files.add(match[1]);
    }
    for (const file of files) {
      await mkdir(dirname(join(stage, file)), { recursive: true });
      await writeFile(
        join(stage, file),
        execFileSync("git", ["-C", repository, "show", `${pin}:${file}`]),
      );
    }
    execFileSync("git", ["init", "--quiet", stage]);
    for (const patch of patches)
      execFileSync("git", ["apply", "--whitespace=error", "-"], { cwd: stage, input: patch });
    // Reapplying rejects the already changed source rather than silently drifting.
    assert.throws(() =>
      execFileSync("git", ["apply", "--check", "-"], {
        cwd: stage,
        input: patches[1],
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const { interruptibleDelay, classifyError, computeBackoff } = await import(
      pathToFileURL(join(stage, "server/drivers/retry.ts"))
    );
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => t.mock.timers.reset());
    const controller = new AbortController();
    const wait = interruptibleDelay(100, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    t.mock.timers.tick(100);
    assert.equal(await wait.promise, "elapsed");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    wait.cancel();
    assert.equal(await wait.promise, "elapsed");
    for (const action of ["abort", "cancel", "already-aborted"]) {
      const controller = new AbortController();
      if (action === "already-aborted") controller.abort();
      const wait = interruptibleDelay(100, controller.signal);
      if (action === "abort") controller.abort();
      if (action === "cancel") wait.cancel();
      assert.equal(await wait.promise, "cancelled");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      wait.cancel();
    }
    const noSignal = interruptibleDelay(100);
    noSignal.cancel();
    assert.equal(await noSignal.promise, "cancelled");
    // Neighboring retry decisions, including user stops and safety blocks, stay terminal.
    for (const text of ["cancelled by user", "401 unauthorized", "blocked by our safety systems"]) {
      assert.equal(classifyError({ text }).transient, false);
    }
    assert.equal(classifyError({ text: "503 service unavailable" }).transient, true);
    assert.equal(
      computeBackoff(0, () => 0.5),
      1000,
    );
  },
);
