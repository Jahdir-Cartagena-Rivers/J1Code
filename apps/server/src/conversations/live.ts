import { Effect, Layer } from "effect";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ExternalConversations, makeExternalConversations } from "./ExternalConversations.ts";
import { makeJ1ConversationSource } from "./J1ConversationSource.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";

export const ExternalConversationsLive = Layer.effect(
  ExternalConversations,
  Effect.gen(function* () {
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    const snapshots = yield* ProjectionSnapshotQuery;
    const messages = yield* ProjectionThreadMessageRepository;
    const directory = makeExternalConversations();
    directory.register(makeJ1ConversationSource(environmentId, snapshots, messages));
    return directory;
  }),
).pipe(Layer.provide(ProjectionThreadMessageRepositoryLive));
