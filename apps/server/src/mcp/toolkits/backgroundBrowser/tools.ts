import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { BackgroundBrowser } from "./runtime.ts";

const dependencies = [McpInvocationContext, ServerSettingsService, BackgroundBrowser];
export const BackgroundBrowserToolkit = Toolkit.make(
  Tool.make("background_browser_tools", {
    description:
      "List the native Lightpanda background browser's tools and argument schemas. Requires a configured executable in this environment's Integrations settings. Browser page state is private to this provider session. Use the collaborative preview for visual inspection, screenshots and recordings.",
    success: Schema.Struct({ tools: Schema.Unknown }),
    failure: Schema.String,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("background_browser_call", {
    description:
      "Call a Lightpanda background browser tool from background_browser_tools using its exact name and JSON arguments. Runs on the J1 server, including remote/mobile connections, independently of the visual preview. Navigation and scripts may change website state. Existing action-time approvals still apply.",
    parameters: Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
      argumentsJson: Schema.String.check(Schema.isMaxLength(100_000)),
    }),
    success: Schema.Struct({ result: Schema.Unknown }),
    failure: Schema.String,
    dependencies,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
  Tool.make("background_browser_close", {
    description:
      "Close this provider session's Lightpanda process and discard its temporary browser page, cookies and storage. Other provider sessions and the collaborative visual preview are unaffected. The next browser call starts a fresh isolated browser.",
    success: Schema.Struct({ closed: Schema.Boolean }),
    failure: Schema.String,
    dependencies,
  }).annotate(Tool.Destructive, true),
);
