import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { BackgroundBrowser } from "./runtime.ts";
import { BackgroundBrowserToolkit } from "./tools.ts";

const decodeArguments = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const request = Effect.fn("BackgroundBrowser.request")(function* (method: string, params: unknown) {
  const scope = yield* requireMcpCapability("preview").pipe(
    Effect.mapError((error) => error.message),
  );
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError((error) => error.message),
  );
  const browser = yield* BackgroundBrowser;
  return yield* browser.request(
    scope.providerSessionId,
    settings.lightpandaExecutablePath,
    method,
    params,
  );
});

export const BackgroundBrowserHandlers = BackgroundBrowserToolkit.toLayer({
  background_browser_tools: () =>
    request("tools/list", {}).pipe(Effect.map((tools) => ({ tools }))),
  background_browser_call: ({ name, argumentsJson }) =>
    Effect.gen(function* () {
      const args = yield* decodeArguments(argumentsJson).pipe(
        Effect.mapError(() => "argumentsJson must contain a JSON object."),
      );
      return { result: yield* request("tools/call", { name, arguments: args }) };
    }),
  background_browser_close: () =>
    Effect.gen(function* () {
      const scope = yield* requireMcpCapability("preview").pipe(
        Effect.mapError((error) => error.message),
      );
      return { closed: yield* (yield* BackgroundBrowser).close(scope.providerSessionId) };
    }),
});
