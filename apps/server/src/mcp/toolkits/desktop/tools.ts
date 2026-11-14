import {
  DesktopActionInput,
  DesktopReadInput,
  DesktopCommandResult,
  DesktopScreenshotInput,
  DesktopScreenshotResult,
  DesktopToolError,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";
import { DesktopAutomation } from "../../../desktop/DesktopAutomation.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext, DesktopAutomation];
const Read = Tool.make("desktop_read", {
  description:
    "Read this J1 server's native desktop with bundled agent-desktop. Start with command=status, then command=skills args=[get,desktop] and [get,platform] for version-matched guidance. Pass command arguments as separate strings, never shell text. For snapshots prefer --app APP -i --compact, then --root REF to drill. References are snapshot-scoped; reobserve after UI changes. Use command --help via args=[--help] for syntax. Browser tasks should use J1 browser tools. Remote clients operate the server computer, not the phone/browser computer. Desktop access must be enabled in Settings > Integrations.",
  parameters: DesktopReadInput,
  success: DesktopCommandResult,
  failure: DesktopToolError,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const Act = Tool.make("desktop_act", {
  description:
    "Operate the server's native desktop with agent-desktop. Prefer fresh accessibility refs over coordinates. args is an argv array, not shell text. Observe after each action. On failure inspect detail.disposition: never retry or substitute an action unless delivery is known not_delivered and retry is safe; otherwise observe first. Headless semantic actions are the default. Set headed=true for physical input only within the user's authorization; never silently escalate after a refusal. For private text use args=[REF,--stdin] and stdin instead of putting text in args. Keep visual computer use available for inaccessible/custom controls; use desktop_screenshot for layout and visual evidence. Logs, files and regression tests are still needed to prove a bug fix.",
  parameters: DesktopActionInput,
  success: DesktopCommandResult,
  failure: DesktopToolError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const DesktopScreenshotTool = Tool.make("desktop_screenshot", {
  description:
    "Capture the J1 server's desktop as an image for visual bug testing, layout inspection and controls missing from the accessibility tree. Prefer an app and optional windowId; screen selects an index from desktop_read list-displays. Take a fresh screenshot before coordinate input. A screenshot alone does not prove a download or backend action succeeded.",
  parameters: DesktopScreenshotInput,
  success: DesktopScreenshotResult,
  failure: DesktopToolError,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
export const DesktopStandardToolkit = Toolkit.make(Read, Act);
export const DesktopScreenshotToolkit = Toolkit.make(DesktopScreenshotTool);
