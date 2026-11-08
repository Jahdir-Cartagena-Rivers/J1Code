import type {
  ExternalRouteSourceSnapshot,
  ExternalRoutingActor,
  ExternalRouteNotice,
  ExternalRouteDelivery,
  ExternalRouteDeliveryResult,
  ExternalRouteHostEvent,
  ExternalRouteReceiptKey,
  ExternalRouteTransportProof,
} from "@t3tools/contracts";
import { Context, Effect, Layer, PubSub, Stream } from "effect";

interface EndpointAdapter {
  readonly proof?: (
    key: ExternalRouteReceiptKey,
  ) => Effect.Effect<ExternalRouteTransportProof | null, string>;
  readonly kind: string;
  readonly accepts: (threadId: string) => boolean;
  readonly source: (threadId: string) => Effect.Effect<ExternalRouteSourceSnapshot | null, string>;
  readonly notice?: (notice: ExternalRouteNotice) => Effect.Effect<void, string>;
  readonly deliver?: (
    input: ExternalRouteDelivery,
  ) => Effect.Effect<ExternalRouteDeliveryResult, string>;
}
type Router = (
  actor: ExternalRoutingActor,
  operation: string,
  input: unknown,
) => Effect.Effect<unknown, string>;

/** Engine-local adapters supply real admission facts; registration never creates projected threads. */
export class ExternalRouteEndpoints extends Context.Service<
  ExternalRouteEndpoints,
  {
    readonly register: (adapter: EndpointAdapter) => () => void;
    readonly proof: (
      key: ExternalRouteReceiptKey,
    ) => Effect.Effect<ExternalRouteTransportProof | null, string>;
    readonly source: (
      threadId: string,
    ) => Effect.Effect<ExternalRouteSourceSnapshot | null, string>;
    readonly registerRouter: (router: Router) => () => void;
    readonly notice: (notice: ExternalRouteNotice) => Effect.Effect<void, string>;
    readonly call: Router;
    readonly deliver: (
      input: ExternalRouteDelivery,
    ) => Effect.Effect<ExternalRouteDeliveryResult, string>;
    readonly receive: (event: ExternalRouteHostEvent) => Effect.Effect<unknown, string>;
    readonly registerReceiver: (
      receiver: (event: ExternalRouteHostEvent) => Effect.Effect<unknown, string>,
    ) => () => void;
    readonly wake: Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<void>, never, import("effect/Scope").Scope>;
  }
>()("t3/routing/ExternalRouteEndpoints") {
  static readonly layer = Layer.effect(
    ExternalRouteEndpoints,
    Effect.gen(function* () {
      const adapters = new Map<string, EndpointAdapter>();
      let router: Router | undefined;
      let receiver: ((event: ExternalRouteHostEvent) => Effect.Effect<unknown, string>) | undefined;
      const changes = yield* PubSub.unbounded<void>();
      return ExternalRouteEndpoints.of({
        proof: (key) =>
          [...adapters.values()]
            .find((adapter) => adapter.accepts(key.destination.threadId))
            ?.proof?.(key) ?? Effect.succeed(null),
        register: (adapter) => {
          if (adapters.has(adapter.kind))
            throw new Error("External route adapter is already registered.");
          adapters.set(adapter.kind, adapter);
          return () => {
            if (adapters.get(adapter.kind) === adapter) adapters.delete(adapter.kind);
          };
        },
        source: (id) =>
          [...adapters.values()].find((adapter) => adapter.accepts(id))?.source(id) ??
          Effect.succeed(null),
        notice: (notice) =>
          [...adapters.values()]
            .find((adapter) => adapter.accepts(notice.endpoint.threadId))
            ?.notice?.(notice) ?? Effect.fail("Source routing notices are unavailable."),
        registerRouter: (current) => {
          if (router) throw new Error("The routing boundary is already registered.");
          router = current;
          return () => {
            if (router === current) router = undefined;
          };
        },
        call: (actor, operation, input) =>
          router ? router(actor, operation, input) : Effect.fail("Routing is not available yet."),
        deliver: (input) =>
          [...adapters.values()]
            .find((adapter) => adapter.accepts(input.destination.threadId))
            ?.deliver?.(input) ?? Effect.fail("Receiving conversation unavailable."),
        receive: (event) =>
          receiver ? receiver(event) : Effect.fail("Routing is not available yet."),
        registerReceiver: (current) => {
          if (receiver) throw new Error("The route receiver is already registered.");
          receiver = current;
          return () => {
            if (receiver === current) receiver = undefined;
          };
        },
        wake: PubSub.publish(changes, undefined).pipe(Effect.asVoid),
        subscribe: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
    }),
  );
}
