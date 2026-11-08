import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  makeExternalConversations,
  type ExternalConversationSource,
  type ExternalConversation,
} from "./ExternalConversations.ts";

const principal = { kind: "j1", environmentId: "local", threadId: "source" } as const;
const endpoint = { environmentId: "local", projectId: "mausbot", threadId: "mausbot:one:thread" };
const source = (read: ExternalConversationSource["read"]): ExternalConversationSource => ({
  kind: "mausbot",
  accepts: (id) => id.startsWith("mausbot:"),
  inspect: () => Effect.succeed(null),
  search: () => Effect.succeed([]),
  read,
  readMessage: () => Effect.fail("Message is unavailable."),
});

describe("real conversation source ownership", () => {
  it.effect("does not fall back to another history after a source disconnects", () =>
    Effect.gen(function* () {
      const directory = makeExternalConversations();
      const remove = directory.register(source(() => Effect.fail("Native history is offline.")));
      expect(yield* directory.read(principal, endpoint).pipe(Effect.flip)).toBe(
        "Native history is offline.",
      );
      remove();
      expect(yield* directory.read(principal, endpoint).pipe(Effect.flip)).toBe(
        "Conversation source is unavailable.",
      );
      expect(yield* directory.search(principal, "one")).toEqual({
        conversations: [],
        unavailable: [],
      });
    }),
  );
  it("rejects a second owner without replacing the working source", () => {
    const directory = makeExternalConversations();
    const existing = source(() => Effect.fail("Existing history"));
    directory.register(existing);
    expect(() => directory.register(source(() => Effect.fail("Replacement")))).toThrow(
      "already registered",
    );
  });
  it.effect("reports an offline engine while keeping the neighboring engine searchable", () =>
    Effect.gen(function* () {
      const directory = makeExternalConversations();
      const working: ExternalConversation = {
        endpoint: { environmentId: "local", projectId: "project", threadId: "source" },
        title: "A working J1 conversation",
        url: "/local/source",
        runtimeMode: "full-access",
        providerInstanceId: ProviderInstanceId.make("codex"),
        activeTurnId: null,
        approvalPending: false,
        inputPending: false,
      };
      directory.register({
        ...source(() => Effect.fail("offline")),
        search: () => Effect.fail("Native history is offline."),
      });
      directory.register({
        ...source(() => Effect.fail("unused")),
        kind: "j1",
        accepts: (id) => !id.startsWith("mausbot:"),
        search: () =>
          Effect.succeed([
            working,
            { ...working, endpoint: { ...working.endpoint, environmentId: "other" } },
          ]),
      });
      expect(yield* directory.search(principal, "one")).toEqual({
        conversations: [working],
        unavailable: [{ source: "mausbot", reason: "Native history is offline." }],
      });
    }),
  );
  it.effect("rejects another environment before invoking its history owner", () =>
    Effect.gen(function* () {
      const directory = makeExternalConversations();
      let reads = 0;
      directory.register(
        source(() =>
          Effect.sync(() => {
            reads++;
            throw new Error("Should not read another environment.");
          }),
        ),
      );
      expect(
        yield* directory.read(principal, { ...endpoint, environmentId: "other" }).pipe(Effect.flip),
      ).toBe("Conversation source is unavailable.");
      expect(reads).toBe(0);
    }),
  );
});
