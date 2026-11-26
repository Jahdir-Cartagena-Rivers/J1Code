import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { ExternalConversations, makeExternalConversations } from "./ExternalConversations.ts";
import { makeJ1ConversationSource } from "./J1ConversationSource.ts";

export const ExternalConversationsLive = Layer.effect(
  ExternalConversations,
  Effect.gen(function* () {
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const threads = yield* ThreadManagementService;
    const search = yield* ThreadSearch;
    const directory = makeExternalConversations();
    directory.register(makeJ1ConversationSource(environmentId, threads, search));
    return directory;
  }),
);
