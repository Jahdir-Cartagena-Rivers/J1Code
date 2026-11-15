import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SessionStore } from "./SessionStore.ts";

export class WorkspaceCredentialInvalid extends Schema.TaggedError<WorkspaceCredentialInvalid>()(
  "WorkspaceCredentialInvalid",
  {},
) {}

export const make = Effect.gen(function* () {
  const sessions = yield* SessionStore;
  const crypto = yield* Crypto.Crypto;
  const issueBrowserSession = sessions.issueWorkspaceBrowserSession;
  const pending = new Map<string, { parentToken: string; expiresAt: number }>();
  yield* Effect.addFinalizer(() => Effect.sync(() => pending.clear()));

  const issue = Effect.fn("WorkspaceSessions.issue")(function* (parentToken: string) {
    const parent = yield* sessions.verify(parentToken);
    const now = yield* Clock.currentTimeMillis;
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
    if (pending.size >= 128) return yield* new WorkspaceCredentialInvalid();
    const credential = yield* crypto.randomUUIDv4;
    const expiresAt = now + 60_000;
    pending.set(credential, { parentToken, expiresAt });
    return { credential, expiresAt: DateTime.makeUnsafe(expiresAt), scopes: parent.scopes };
  });

  const redeem = Effect.fn("WorkspaceSessions.redeem")(function* (credential: string) {
    const entry = pending.get(credential);
    // Consume before yielding so concurrent redemptions cannot duplicate a handoff.
    pending.delete(credential);
    const now = yield* Clock.currentTimeMillis;
    if (!entry || entry.expiresAt <= now) return yield* new WorkspaceCredentialInvalid();
    return yield* issueBrowserSession(entry.parentToken);
  });
  return { issue, redeem };
});

export class WorkspaceSessions extends Context.Service<
  WorkspaceSessions,
  Effect.Success<typeof make>
>()("@j1code/server/auth/WorkspaceSessions") {}

export const layer = Layer.effect(WorkspaceSessions, make);
