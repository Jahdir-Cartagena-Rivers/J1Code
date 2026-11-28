import { DesktopToolError } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import { DesktopAutomation } from "../../../desktop/DesktopAutomation.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import { DesktopStandardToolkit, DesktopScreenshotToolkit } from "./tools.ts";

const access = requireThreadMcpCapability("desktop").pipe(
  Effect.filterOrFail(
    (scope) => scope.client === undefined,
    () => new Error("Provider thread required"),
  ),
  Effect.mapError(
    () =>
      new DesktopToolError({
        reason:
          "Agent desktop access is disabled for this J1 backend. Enable it in Settings > Integrations, then start a new agent session. Existing visual computer integrations retain their own permissions.",
        actionMayHaveRun: false,
      }),
  ),
);
export const DesktopStandardHandlersLive = DesktopStandardToolkit.toLayer(
  Effect.succeed(
    DesktopStandardToolkit.of({
      desktop_read: Effect.fn("DesktopToolkit.read")(function* (input) {
        const scope = yield* access;
        const desktop = yield* DesktopAutomation;
        return yield* desktop.run(scope, input.command, input.args ?? []);
      }),
      desktop_act: Effect.fn("DesktopToolkit.act")(function* (input) {
        const scope = yield* access;
        const desktop = yield* DesktopAutomation;
        return yield* desktop.run(scope, input.command, input.args ?? [], {
          action: true,
          ...(input.headed === undefined ? {} : { headed: input.headed }),
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        });
      }),
    }),
  ),
);
export const DesktopScreenshotHandlersLive = DesktopScreenshotToolkit.toLayer(
  Effect.succeed(
    DesktopScreenshotToolkit.of({
      desktop_screenshot: Effect.fn("DesktopToolkit.screenshot")(function* (input) {
        const scope = yield* access;
        const desktop = yield* DesktopAutomation;
        return yield* desktop.screenshot(scope, input);
      }),
    }),
  ),
);
