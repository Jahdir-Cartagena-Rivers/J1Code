import { DesktopToolError } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import { DesktopAutomation } from "../../../desktop/DesktopAutomation.ts";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { DesktopStandardToolkit, DesktopScreenshotToolkit } from "./tools.ts";

const access = requireMcpCapability("desktop").pipe(
  Effect.mapError(
    () =>
      new DesktopToolError({
        reason:
        "Agent desktop access is disabled for this J1 backend. Enable it in Settings > Integrations, then start a new agent session. Existing visual computer integrations retain their own permissions.",
        actionMayHaveRun: false,
      }),
  ),
);
export const DesktopStandardHandlersLive = DesktopStandardToolkit.toLayer({
  desktop_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* access;
      const desktop = yield* DesktopAutomation;
      return yield* desktop.run(scope, input.command, input.args ?? []);
    }),
  desktop_act: (input) =>
    Effect.gen(function* () {
      const scope = yield* access;
      const desktop = yield* DesktopAutomation;
      return yield* desktop.run(scope, input.command, input.args ?? [], {
        action: true,
        ...(input.headed === undefined ? {} : { headed: input.headed }),
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      });
    }),
});
export const DesktopScreenshotHandlersLive = DesktopScreenshotToolkit.toLayer({
  desktop_screenshot: (input) =>
    Effect.gen(function* () {
      const scope = yield* access;
      const desktop = yield* DesktopAutomation;
      return yield* desktop.screenshot(scope, input);
    }),
});
