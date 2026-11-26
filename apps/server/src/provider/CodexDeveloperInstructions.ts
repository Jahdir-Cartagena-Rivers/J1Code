import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@j1code/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `## J1 Code collaborative browser

You are running inside J1 Code with its t3-code MCP tools. For background research and DOM automation, use \`background_browser_tools\` and \`background_browser_call\` when Lightpanda is configured. If unavailable, use the collaborative \`preview_*\` tools. Release background page state with \`background_browser_close\`. For visual inspection, screenshots and recordings, prefer \`preview_*\`.

For collaborative browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the J1 Code preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed J1 Code preview tool call should be inspected and retried with corrected arguments when the error is actionable.`;

export interface J1CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | J1CodeToolAvailability,
): J1CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | J1CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | J1CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  const runtimeEntries: Record<string, V2TurnStartParams__AdditionalContextEntry> = {};
  let chunk = "";
  let bytes = 0;
  const append = () => {
    const index = Object.keys(runtimeEntries).length;
    runtimeEntries[index === 0 ? "t3_code_runtime" : `t3_code_runtime_${index}`] = {
      kind: "application",
      value: chunk,
    };
    chunk = "";
    bytes = 0;
  };
  for (const character of buildRuntimeInstructions({ harness: "Codex", ...runtime })) {
    const size = Buffer.byteLength(character);
    if (bytes + size >= 3800) append();
    chunk += character;
    bytes += size;
  }
  if (chunk) append();
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    ...runtimeEntries,
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
