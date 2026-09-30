const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const AGENT_DELEGATION_INSTRUCTIONS = `<agent_delegation>
When the t3-code MCP server exposes spawn_agent, you can delegate tasks to any configured provider and model, including other harnesses. Call list_agent_models first and pass its exact instanceId and model slug. spawn_agent creates a saved worker chat in this project's current workspace with the parent's permission mode. Include all context and a bounded task; workers do not receive your conversation automatically. Partition file ownership before parallel edits in the shared workspace. Use a stable requestId for retries. Use wait_agent or get_agent_result to read progress and the final answer; a completed worker response is evidence to review, not proof that the user's goal is complete. Workers may delegate further within the reported limits. Never answer worker approval prompts on the user's behalf; direct the user to the worker chat when it needs input. Use cancel_agent to stop a worker and its descendants. Do not finish a delegated task until required workers have returned or you have cancelled them and reported the limitation.
</agent_delegation>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in J1 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${AGENT_DELEGATION_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
