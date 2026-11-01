// @effect-diagnostics nodeBuiltinImport:off - isolated SQLite close/reopen fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, ManagedRuntime } from "effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/062_TaskOwnerBindings.ts";
import {
  makeTaskOwnerStore,
  TaskOwnerStoreError,
  type TaskOwnerVerifier,
} from "./taskOwnerStore.ts";

// eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
const runtime = (filename: string) => ManagedRuntime.make(NodeSqliteClient.layer({ filename }));
const scope = { environmentId: "env", projectId: "project" };
const binding = { ...scope, bindingId: "binding", taskId: "task", threadId: "thread" };
const verifier: TaskOwnerVerifier = {
  verify: () =>
    Effect.succeed({
      principalId: "authenticated-user",
      requestId: "request",
      authenticatedAt: 42,
    }),
};

describe("task owner bindings", () => {
  it("deduplicates concurrent bindings, preserves conflicts, scopes lookup and revokes explicitly", async () => {
    const db = runtime(":memory:");
    try {
      await db.runPromise(migration);
      const store = await db.runPromise(makeTaskOwnerStore(verifier));
      await db.runPromise(
        Effect.all(
          Array.from({ length: 8 }, () => store.bind(binding)),
          { concurrency: "unbounded" },
        ),
      );
      expect(await db.runPromise(store.history("task", scope))).toHaveLength(1);
      const race = await Promise.allSettled([
        db.runPromise(store.bind({ ...binding, bindingId: "race", threadId: "a" })),
        db.runPromise(store.bind({ ...binding, bindingId: "race", threadId: "b" })),
      ]);
      expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect((await db.runPromise(store.lookupDurable("task", scope))).status).toBe("ambiguous");
      expect(
        (await db.runPromise(store.lookupDurable("task", { ...scope, environmentId: "other" })))
          .status,
      ).toBe("none");
      await db.runPromise(store.revoke("race"));
      expect((await db.runPromise(store.lookupDurable("task", scope))).owner).toEqual({
        ...scope,
        threadId: "thread",
      });
      const shell = {
        ...scope,
        threadId: "thread",
        taskIds: ["task"],
        state: "available" as const,
      };
      expect((await db.runPromise(store.lookupCurrent("task", scope, [shell]))).status).toBe(
        "bound",
      );
      for (const shells of [
        [],
        [shell, shell],
        [{ ...shell, state: "archived" as const }],
        [{ ...shell, taskIds: [] }],
      ]) {
        const result = await db.runPromise(store.lookupCurrent("task", scope, shells));
        expect(result.status).toBe("unavailable");
        expect(result.owner).toBeNull();
      }
      await db.runPromise(store.unbind("binding"));
      await expect(db.runPromise(store.bind(binding))).rejects.toThrow("binding-revoked");
      expect((await db.runPromise(store.lookupDurable("task", scope))).status).toBe("none");
      expect(await db.runPromise(store.history("task", scope))).toHaveLength(2);
      await db.runPromise(
        Effect.all(
          [
            store.bind({ ...binding, bindingId: "new" }),
            store.bind({ ...binding, bindingId: "same-owner" }),
          ],
          { concurrency: "unbounded" },
        ),
      );
      expect((await db.runPromise(store.lookupDurable("task", scope))).status).toBe("bound");
    } finally {
      await db.dispose();
    }
  });

  it("fails closed on rejected authentication and invalid IDs, including revocation", async () => {
    const db = runtime(":memory:");
    try {
      await db.runPromise(migration);
      const allowed = await db.runPromise(makeTaskOwnerStore(verifier));
      const denied = await db.runPromise(
        makeTaskOwnerStore({
          verify: () => Effect.fail(new TaskOwnerStoreError({ reason: "unauthorized" })),
        }),
      );
      await expect(db.runPromise(denied.bind(binding))).rejects.toThrow("unauthorized");
      expect(await db.runPromise(allowed.get("binding"))).toBeNull();
      await expect(db.runPromise(allowed.bind({ ...binding, taskId: " " }))).rejects.toThrow();
      await allowed.bind(binding).pipe(db.runPromise);
      await expect(db.runPromise(denied.revoke("binding"))).rejects.toThrow("unauthorized");
      expect((await db.runPromise(allowed.get("binding")))?.revocation).toBeNull();
    } finally {
      await db.dispose();
    }
  });

  it("retains provenance, ambiguity and revocations after SQLite restart", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-task-owners-"));
    const dbPath = NodePath.join(dir, "owners.sqlite");
    let db = runtime(dbPath);
    try {
      await db.runPromise(migration);
      let store = await db.runPromise(makeTaskOwnerStore(verifier));
      await db.runPromise(store.bind(binding));
      await db.runPromise(store.bind({ ...binding, bindingId: "other", threadId: "other" }));
      await db.dispose();
      db = runtime(dbPath);
      store = await db.runPromise(makeTaskOwnerStore(verifier));
      expect((await db.runPromise(store.lookupDurable("task", scope))).status).toBe("ambiguous");
      expect((await db.runPromise(store.get("binding")))?.provenance.principalId).toBe(
        "authenticated-user",
      );
      await db.runPromise(store.revoke("other"));
      await db.dispose();
      db = runtime(dbPath);
      store = await db.runPromise(makeTaskOwnerStore(verifier));
      expect((await db.runPromise(store.lookupDurable("task", scope))).status).toBe("bound");
      await expect(
        db.runPromise(store.bind({ ...binding, bindingId: "other", threadId: "other" })),
      ).rejects.toThrow("binding-revoked");
    } finally {
      await db.dispose();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
