// @effect-diagnostics nodeBuiltinImport:off - native temporary file close/reopen fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, ManagedRuntime } from "effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/060_DurableRoutes.ts";
import {
  makeDurableRoutingStoreWithResolution,
  makeDurableRoutingStore,
} from "./durableRoutingStore.ts";
import type { RouteRequest, RouteReceipt } from "./routeState.ts";

const request: RouteRequest = {
  requestId: "stable",
  source: { environmentId: "env", projectId: "p", threadId: "source" },
  destination: { environmentId: "env", projectId: "p", threadId: "target" },
  content: "hello",
  permissionCeiling: [],
  destinationPermissions: [],
  visited: [],
  maxHops: 3,
  ambiguous: false,
  mode: "auto",
  initiation: "manual",
};
// Explicit runtime lifetimes exercise SQLite close/reopen crash recovery against the same file.
// eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
const runtime = (path: string) => ManagedRuntime.make(NodeSqliteClient.layer({ filename: path }));

describe("durable routing store", () => {
  it("atomically deduplicates concurrent requests and rejects changed input and stale send claims", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-routing-"));
    const db = runtime(NodePath.join(dir, "routes.sqlite"));
    try {
      await db.runPromise(migration);
      const store = await db.runPromise(makeDurableRoutingStore);
      const rows = await db.runPromise(
        Effect.all(
          Array.from({ length: 12 }, () => store.create(request)),
          { concurrency: "unbounded" },
        ),
      );
      expect(rows.every((row) => row.revision === 0 && row.state.status === "queued")).toBe(true);
      const raced = await Promise.allSettled([
        db.runPromise(store.create({ ...request, requestId: "race", content: "a" })),
        db.runPromise(store.create({ ...request, requestId: "race", content: "b" })),
      ]);
      expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(
        db.runPromise(store.create({ ...request, content: "changed" })),
      ).rejects.toThrow();
      const claims = await Promise.allSettled(
        ["a", "b"].map((attemptId) =>
          db.runPromise(store.transition("stable", 0, { type: "begin-send", attemptId })),
        ),
      );
      expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await db.runPromise(store.get("stable")))?.revision).toBe(1);
    } finally {
      await db.dispose();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("reopens persisted sending as uncertain, retains receipts, and rejects invalid receipt order/identity and resend", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-routing-"));
    const path = NodePath.join(dir, "routes.sqlite");
    let db = runtime(path);
    try {
      await db.runPromise(migration);
      let store = await db.runPromise(makeDurableRoutingStore);
      await db.runPromise(store.create(request));
      await db.runPromise(
        store.transition("stable", 0, { type: "begin-send", attemptId: "attempt" }),
      );
      await db.dispose();
      db = runtime(path);
      store = await db.runPromise(makeDurableRoutingStore);
      expect((await db.runPromise(store.get("stable")))?.state.status).toBe("sending");
      expect(await db.runPromise(store.recoverInterruptedSends())).toBe(1);
      expect(await db.runPromise(store.recoverInterruptedSends())).toBe(0);
      let row = (await db.runPromise(store.get("stable")))!;
      expect(row.state.status).toBe("uncertain");
      await expect(
        db.runPromise(
          store.transition("stable", row.revision, { type: "begin-send", attemptId: "retry" }),
        ),
      ).rejects.toThrow();
      const receipt: RouteReceipt = {
        receiptId: "receipt",
        requestId: "stable",
        fingerprint: row.state.fingerprint,
        attemptId: "attempt",
        destination: request.destination!,
        kind: "delivered",
      };
      for (const invalid of [
        { ...receipt, kind: "accepted" as const },
        { ...receipt, attemptId: "wrong" },
        { ...receipt, fingerprint: "wrong" },
        { ...receipt, destination: request.source },
      ]) {
        await expect(
          db.runPromise(
            store.transition("stable", row.revision, { type: "receipt", receipt: invalid }),
          ),
        ).rejects.toThrow();
      }
      row = await db.runPromise(
        store.transition("stable", row.revision, { type: "receipt", receipt }),
      );
      expect(row.state.status).toBe("delivered");
      expect(
        await db.runPromise(store.transition("stable", row.revision, { type: "receipt", receipt })),
      ).toEqual(row);
      await expect(
        db.runPromise(
          store.transition("stable", row.revision, {
            type: "receipt",
            receipt: { ...receipt, kind: "failed" },
          }),
        ),
      ).rejects.toThrow();
      for (const kind of ["accepted", "completed"] as const)
        row = await db.runPromise(
          store.transition("stable", row.revision, {
            type: "receipt",
            receipt: { ...receipt, receiptId: kind, kind },
          }),
        );
      await db.dispose();
      db = runtime(path);
      store = await db.runPromise(makeDurableRoutingStore);
      expect(await db.runPromise(store.get("stable"))).toEqual(row);
      const queued = await db.runPromise(store.create({ ...request, requestId: "failed-route" }));
      expect(await db.runPromise(store.recoverInterruptedSends())).toBe(0);
      expect(await db.runPromise(store.get("failed-route"))).toEqual(queued);
      const sending = await db.runPromise(
        store.transition("failed-route", 0, { type: "begin-send", attemptId: "failure-attempt" }),
      );
      const failed = await db.runPromise(
        store.transition("failed-route", sending.revision, {
          type: "receipt",
          receipt: {
            ...receipt,
            requestId: "failed-route",
            attemptId: "failure-attempt",
            receiptId: "failure",
            kind: "failed",
          },
        }),
      );
      expect(failed.state.status).toBe("failed");
      await expect(
        db.runPromise(
          store.transition("failed-route", failed.revision, {
            type: "begin-send",
            attemptId: "retry",
          }),
        ),
      ).rejects.toThrow();
      expect(row.state.receipts.map((entry) => entry.kind)).toEqual([
        "delivered",
        "accepted",
        "completed",
      ]);
    } finally {
      await db.dispose();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

it("persists immutable intent and a single competing authenticated resolution across reopen", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-route-resolution-"));
  const path = NodePath.join(dir, "routes.sqlite");
  let db = runtime(path);
  const original = {
    ...request,
    destination: null,
    ambiguous: true,
    taskId: "task",
    sourceUrl: "j1://origin",
  };
  try {
    await db.runPromise(migration);
    const untrusted = await db.runPromise(makeDurableRoutingStore);
    const initial = await db.runPromise(untrusted.create(original));
    expect(initial.state.status).toBe("suggested");
    await expect(
      db.runPromise(untrusted.resolve("stable", 0, request.destination!)),
    ).rejects.toThrow();
    await expect(
      db.runPromise(untrusted.transition("stable", 0, { type: "confirm" })),
    ).rejects.toThrow();
    const store = await db.runPromise(
      makeDurableRoutingStoreWithResolution({
        verify: (_id, destination) =>
          Effect.succeed({
            authenticatedUser: true,
            userId: "user",
            source: request.source,
            destination,
            destinationPermissions: [],
          }),
      }),
    );
    const results = await Promise.allSettled(
      ["one", "two"].map((threadId) =>
        db.runPromise(store.resolve("stable", 0, { ...request.destination!, threadId })),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await db.runPromise(store.get("stable"));
    expect(row?.revision).toBe(1);
    expect(row?.state.originalRequest).toEqual(original);
    expect(
      await db.runPromise(
        store.create({ ...original, destination: request.destination, ambiguous: false }),
      ),
    ).toEqual(row);
    await expect(
      db.runPromise(store.create({ ...original, content: "different" })),
    ).rejects.toThrow();
    await db.dispose();
    db = runtime(path);
    const reopened = await db.runPromise(makeDurableRoutingStore);
    expect(await db.runPromise(reopened.get("stable"))).toEqual(row);
  } finally {
    await db.dispose();
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
