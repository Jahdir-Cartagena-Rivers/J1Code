import {
  ProviderDriverKind,
  type OrchestrationV2ProviderThread,
  type ProviderUserInputAnswers,
} from "@j1code/contracts";
import {
  makeCursorDriver,
  type CursorAdapterComposition,
  type CursorDriverEnv as SdkEnv,
} from "@j1code/provider-cursor/server";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
} from "@j1code/provider-acp/server/adapter";
import * as AcpSessionRuntime from "@j1code/provider-acp/server/AcpSessionRuntime";
import { acpPermissionDisposition } from "@j1code/provider-acp/server/clientPolicy";
import { flattenSelectChoices } from "@j1code/provider-acp/server/sessionConfig";
import * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import { resolveSelfInvocation } from "@j1code/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";

const driver = ProviderDriverKind.make("cursor");
const protocolError = (detail: string) =>
  new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail });
type Policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy;
type Transport = "acp" | "sdk";

export const cursorNeedsInteractiveTransport = (policy: Policy): boolean =>
  policy.interactionMode === "plan" ||
  policy.runtimeMode === "approval-required" ||
  policy.runtimeMode === "auto-accept-edits" ||
  (policy.approvalPolicy !== undefined && policy.approvalPolicy !== "never") ||
  (policy.sandboxPolicy !== undefined &&
    !(
      typeof policy.sandboxPolicy === "object" &&
      policy.sandboxPolicy !== null &&
      "type" in policy.sandboxPolicy &&
      policy.sandboxPolicy.type === "dangerFullAccess"
    ));

export const selectCursorTransport = (
  input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
): Transport =>
  input.initialCursorTransport ??
  // Older V2 Cursor records were SDK-only. An imported ACP record is marked by turn start.
  (input.initialNativeThreadId === undefined && cursorNeedsInteractiveTransport(input.runtimePolicy)
    ? "acp"
    : "sdk");

const CursorQuestions = Schema.Struct({
  toolCallId: Schema.String,
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      prompt: Schema.String,
      options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
      allowMultiple: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const CursorPlan = Schema.Struct({ plan: Schema.String });

export const registerCursorAcpExtensions = Effect.fn("CursorInteractive.registerExtensions")(
  function* ({ runtime, requestUserInput, captureProposedPlan }: AcpAdapterV2ExtensionContext) {
    yield* runtime.handleExtRequest("cursor/ask_question", CursorQuestions, (params, context) =>
      Effect.gen(function* () {
        const { answers, acknowledgeNativeResponse } = yield* requestUserInput(
          {
            nativeItemId: params.toolCallId,
            nativeRequestId: params.toolCallId,
            questions: params.questions.map((question) => ({
              id: question.id,
              header: "Question",
              question: question.prompt,
              multiSelect: question.allowMultiple === true,
              options:
                question.options.length === 0
                  ? [{ label: "OK", description: "Continue" }]
                  : question.options.map(({ label }) => ({ label, description: label })),
            })),
          },
          context,
        );
        yield* acknowledgeNativeResponse;
        const response: ProviderUserInputAnswers = answers ?? {};
        return { answers: response };
      }),
    );
    yield* runtime.handleExtRequest("cursor/create_plan", CursorPlan, ({ plan }) =>
      captureProposedPlan({
        planMarkdown: plan || "# Plan\n\n(Cursor did not supply plan text.)",
      }).pipe(Effect.as({ accepted: true })),
    );
  },
);

const optionAliases = {
  reasoning: ["reasoning", "reasoningeffort", "effort", "effortlevel"],
  contextWindow: ["contextwindow", "context", "contextsize"],
  fastMode: ["fastmode", "fast"],
  thinking: ["thinking", "thinkingmode"],
} as const;
const normalizeOption = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const isTransportError = Schema.is(AcpErrors.AcpTransportError);
const isProcessExitedError = Schema.is(AcpErrors.AcpProcessExitedError);
const applyModelSelection: NonNullable<AcpAdapterV2Flavor["applyModelSelection"]> = Effect.fn(
  "CursorInteractive.applyModelSelection",
)(function* ({ runtime, modelSelection }) {
  const base = modelSelection.model.split("[", 1)[0]?.trim();
  if (base !== undefined && base !== "" && base !== "auto" && base !== "default") {
    yield* runtime.setSessionModel(base);
  }
  const nativeOptions = yield* runtime.getConfigOptions;
  for (const selection of modelSelection.options ?? []) {
    if (!Object.hasOwn(optionAliases, selection.id)) continue;
    const aliases: ReadonlyArray<string> =
      optionAliases[selection.id as keyof typeof optionAliases];
    const native = nativeOptions.find(
      ({ id, name }) =>
        aliases.includes(normalizeOption(id)) || aliases.includes(normalizeOption(name)),
    );
    if (native?.type === "boolean" && typeof selection.value === "boolean") {
      yield* runtime.setConfigOption(native.id, selection.value);
    } else if (native?.type === "select") {
      const expected =
        typeof selection.value === "boolean"
          ? selection.value
            ? ["true", "on", "enabled"]
            : ["false", "off", "disabled"]
          : [normalizeOption(selection.value)];
      const choice = flattenSelectChoices(native.options).find(
        ({ value, name }) =>
          expected.includes(normalizeOption(value)) || expected.includes(normalizeOption(name)),
      );
      if (choice !== undefined) yield* runtime.setConfigOption(native.id, choice.value);
    }
  }
  return base;
});

const makeCursorInteractiveAdapter = Effect.fn("makeCursorInteractiveAdapter")(function* (
  config: CursorAdapterComposition,
) {
  const path = yield* Path.Path;
  const selfInvocation = yield* resolveSelfInvocation();
  const flavor: AcpAdapterV2Flavor = {
    driver,
    runtimeHarness: "Cursor",
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      planning: { ...AcpProviderCapabilitiesV2.planning, emitsProposedPlan: true },
    },
    clientCapabilitiesMeta: { parameterizedModelPicker: true },
    supportsImagePrompts: true,
    interruptPromptOnCancel: true,
    restartRuntimeAfterInterrupt: true,
    terminateRuntimeProcessGroupOnInterrupt: true,
    restartRuntimeAfterPromptError: (error) =>
      isTransportError(error) || isProcessExitedError(error),
    applyModelSelection,
    ownedModelOptionIds: Object.keys(optionAliases),
    permissionDisposition: (policy, request) => {
      const sandbox = policy.sandboxPolicy;
      return typeof sandbox === "object" &&
        sandbox !== null &&
        "type" in sandbox &&
        sandbox.type === "readOnly"
        ? acpPermissionDisposition({ ...policy, approvalPolicy: "never" }, request)
        : acpPermissionDisposition(policy, request);
    },
    registerExtensions: registerCursorAcpExtensions,
    makeRuntime: Effect.fn("CursorInteractive.makeRuntime")(function* (input) {
      const key = yield* config.auth.requireApiKey.pipe(
        Effect.mapError(
          (cause) =>
            new AcpErrors.AcpTransportError({ detail: "Cursor sign-in is required", cause }),
        ),
      );
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...input,
          spawn: {
            command: config.config.binaryPath?.trim() || "cursor-agent",
            args: [
              ...(config.config.apiEndpoint?.trim()
                ? ["-e", config.config.apiEndpoint.trim()]
                : []),
              // Keep native callbacks enabled. J1 answers Full Access automatically and
              // can enforce a stricter policy on the next turn without a bypass flag.
              "acp",
            ],
            cwd: input.cwd,
            env: { ...config.environment, CURSOR_API_KEY: key },
          },
          authMethodId: "cursor_login",
          authenticateOnAuthRequired: false,
          ownDetachedProcessGroup: true,
        }),
      );
      return yield* AcpSessionRuntime.AcpSessionRuntime.pipe(Effect.provide(context));
    }),
  };
  const acp = yield* makeAcpAdapterV2({ instanceId: config.instanceId, flavor, selfInvocation });
  return composeCursorTransports(config.sdk, acp, config.auth.withAccess, path);
});

export function composeCursorTransports(
  sdk: ProviderAdapter.ProviderAdapterV2["Service"],
  acp: ProviderAdapter.ProviderAdapterV2["Service"],
  withAccess: CursorAdapterComposition["auth"]["withAccess"],
  path: Path.Path,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...sdk,
    getCapabilities: () =>
      Effect.all([sdk.getCapabilities(), acp.getCapabilities()]).pipe(
        Effect.map(([sdkCapabilities, acpCapabilities]) => ({
          ...sdkCapabilities,
          approvals: acpCapabilities.approvals,
          planning: { ...sdkCapabilities.planning, supportsStructuredQuestions: true },
        })),
      ),
    openSession: Effect.fn("CursorInteractive.openSession")(function* (input) {
      if (
        input.modelSelection.instanceId !== sdk.instanceId ||
        (input.resumeFromSession !== undefined &&
          (input.resumeFromSession.driver !== driver ||
            input.resumeFromSession.providerInstanceId !== sdk.instanceId))
      ) {
        return yield* protocolError("Cursor cannot open a conversation for another account.");
      }
      const transport = selectCursorTransport(input);
      const storeCwd = input.initialCursorStoreCwd;
      const cwd = input.runtimePolicy.cwd;
      if (transport === "acp") {
        if (cwd === null || !path.isAbsolute(cwd))
          return yield* protocolError("Cursor ACP requires an absolute workspace path.");
        if (
          input.initialNativeThreadId !== undefined &&
          (storeCwd === undefined ||
            !path.isAbsolute(storeCwd) ||
            path.relative(storeCwd, cwd) !== "")
        )
          return yield* protocolError(
            "Cursor must reopen the ACP conversation in its original workspace.",
          );
      }
      if (transport === "sdk" && cursorNeedsInteractiveTransport(input.runtimePolicy)) {
        return yield* protocolError(
          "This saved SDK conversation cannot switch transports for interactive review.",
        );
      }
      const runtime = yield* transport === "acp"
        ? withAccess(
            acp.openSession({
              ...input,
              ...(input.initialNativeThreadId === undefined
                ? {}
                : { requireExactInitialNativeThread: true }),
            }),
          ).pipe(
            Effect.catchTags({
              ProviderSetupError: (cause) =>
                Effect.fail(
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
                ),
            }),
          )
        : sdk.openSession(input);
      const owns = (thread: OrchestrationV2ProviderThread) =>
        thread.driver === driver &&
        thread.providerInstanceId === sdk.instanceId &&
        thread.appThreadId === input.threadId &&
        (thread.nativeThreadRef == null || thread.nativeThreadRef.driver === driver) &&
        (thread.nativeMetadata?.cursorTransport === undefined ||
          thread.nativeMetadata.cursorTransport === transport);
      const stamp = (thread: OrchestrationV2ProviderThread): OrchestrationV2ProviderThread => ({
        ...thread,
        nativeMetadata: {
          ...thread.nativeMetadata,
          cursorTransport: transport,
          ...(transport === "acp" && input.runtimePolicy.cwd !== null
            ? { cursorStoreCwd: storeCwd ?? input.runtimePolicy.cwd }
            : {}),
        },
      });
      const accepts = (policy: Policy) =>
        transport === "acp"
          ? policy.cwd === input.runtimePolicy.cwd
          : !cursorNeedsInteractiveTransport(policy);
      const failOwner = () =>
        Effect.fail(protocolError("Cursor conversation ownership or transport changed."));
      const startTurn: typeof runtime.startTurn = (turn) =>
        owns(turn.providerThread) &&
        turn.threadId === input.threadId &&
        turn.modelSelection.instanceId === sdk.instanceId &&
        accepts(turn.runtimePolicy)
          ? runtime.startTurn(turn)
          : failOwner();
      return {
        ...runtime,
        events: runtime.events.pipe(
          Stream.map((event) =>
            event.type === "provider_thread.updated"
              ? { ...event, providerThread: stamp(event.providerThread) }
              : event,
          ),
        ),
        ensureThread: (request) =>
          request.threadId === input.threadId &&
          request.modelSelection.instanceId === sdk.instanceId &&
          accepts(request.runtimePolicy) &&
          (request.existingProviderThread === undefined || owns(request.existingProviderThread))
            ? runtime.ensureThread(request).pipe(Effect.map(stamp))
            : failOwner(),
        resumeThread: (request) =>
          owns(request.providerThread) &&
          request.providerThread.nativeThreadRef?.strength === "strong" &&
          (request.threadId === undefined || request.threadId === input.threadId) &&
          (request.modelSelection === undefined ||
            request.modelSelection.instanceId === sdk.instanceId) &&
          (request.runtimePolicy === undefined || accepts(request.runtimePolicy))
            ? runtime
                .resumeThread(request)
                .pipe(
                  Effect.flatMap((thread) =>
                    owns(thread) &&
                    thread.nativeThreadRef?.strength === "strong" &&
                    thread.nativeThreadRef.nativeId ===
                      request.providerThread.nativeThreadRef?.nativeId
                      ? Effect.succeed(stamp(thread))
                      : Effect.fail(
                          protocolError("Cursor returned a different native conversation."),
                        ),
                  ),
                )
            : failOwner(),
        startTurn,
        ...(runtime.resumeTurn === undefined
          ? {}
          : {
              resumeTurn: (request: Parameters<NonNullable<typeof runtime.resumeTurn>>[0]) =>
                owns(request.providerThread) &&
                request.threadId === input.threadId &&
                request.modelSelection.instanceId === sdk.instanceId &&
                accepts(request.runtimePolicy)
                  ? runtime.resumeTurn!(request)
                  : failOwner(),
            }),
        interruptTurn: (request) =>
          owns(request.providerThread) ? runtime.interruptTurn(request) : failOwner(),
        steerTurn: (request) =>
          owns(request.providerThread) &&
          request.threadId === input.threadId &&
          (request.modelSelection === undefined ||
            request.modelSelection.instanceId === sdk.instanceId)
            ? runtime.steerTurn(request)
            : failOwner(),
        readThreadSnapshot: (request) =>
          owns(request.providerThread)
            ? runtime.readThreadSnapshot(request).pipe(
                Effect.map((snapshot) => ({
                  ...snapshot,
                  providerThread: stamp(snapshot.providerThread),
                })),
              )
            : failOwner(),
        rollbackThread: (request) =>
          owns(request.providerThread)
            ? runtime.rollbackThread(request).pipe(
                Effect.map((snapshot) => ({
                  ...snapshot,
                  providerThread: stamp(snapshot.providerThread),
                })),
              )
            : failOwner(),
        forkThread: (request) =>
          owns(request.sourceProviderThread)
            ? runtime.forkThread(request).pipe(Effect.map(stamp))
            : failOwner(),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
  };
}

export const CursorDriver = makeCursorDriver(makeCursorInteractiveAdapter);
export type CursorDriverEnv =
  | SdkEnv
  | Effect.Services<ReturnType<typeof makeCursorInteractiveAdapter>>;
