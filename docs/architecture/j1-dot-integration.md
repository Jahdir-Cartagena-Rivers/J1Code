# Connect the actual ChatGPT Dot to J1

The target is the user's existing ChatGPT Dot. Keep its identity, memory, cloud computer, and conversation in ChatGPT. A new Codex coordinator or an API model with similar instructions would not be the same Dot.

## Supported route verified on 2026-09-30

[Dot computer/app documentation](https://learn.chatgpt.com/docs/dots/computers-and-apps) explicitly says Dots can use supported installed plugins. The user's signed-in ChatGPT Plugins UI exposes **Add > Create MCP App**, with **Tunnel** and OAuth connection options. No plugin was created or account settings changed during inspection.

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) lets a local tunnel client make an outbound HTTPS connection to OpenAI and forward MCP requests to a private local server. It requires a Platform tunnel, runtime API key, tunnel permissions, and association with the correct ChatGPT workspace. It supports private developer-mode use, not public plugin distribution. This transport still requires the PC/server to be online; Dot's cloud computer does not keep J1's local provider processes alive when the PC shuts down.

## Implementation

1. Add a dedicated `/dot/mcp` adapter over J1's existing orchestration/provider services. Keep the existing provider-session `/mcp` delegation route and credentials separate.
2. Create a revocable paired plugin identity with explicit project grants. Use the existing environment OAuth/pairing primitives for connection; grant read access and task creation separately. Never export provider login credentials or the desktop bootstrap credential to Dot.
3. Start with tools to list granted projects and configured models, list/read granted chats with bounded pagination, create a saved J1 task, inspect its progress/results, and cancel tasks created by this connection. Creation must retain the user's permission mode and normal worker approvals, deadlines, quotas, and cancellation. Stable request IDs make retrying task creation idempotent.
4. Persist the connection, task ownership, and result cursor in J1 so calls survive desktop close, tunnel reconnect, and backend restart. Reject unknown projects, unrelated task cancellation, ungranted chat reads, and expired/revoked connections. Poll results through tools first; optional MCP events can follow after their delivery/retry behavior is verified.
5. Run the official tunnel client beside the background server, configure only the dedicated endpoint, and connect a personal J1 plugin in ChatGPT. Validate a real read-only Dot tool call, then one bounded task with its result returned to the same Dot. Installation/authentication is the final account connection step after the adapter is built and reviewed.

Existing `/mcp` tokens are scoped to active J1 provider sessions and parent chats. Reusing one for Dot would couple Dot's permissions to an unrelated chat and fail when that session changes. A tunnel alone does not fix that engineering gap.

## Chat and coordination boundary

Dot can coordinate Claude/Codex and other J1 agents by calling the plugin; J1 stores those worker chats and results. This does not require making Dot an API model or moving its cloud computer onto the PC. Voice, personality settings, Dot memory, and the original Dot conversation continue to live in ChatGPT. J1 can link/open that conversation and display J1 task activity.

A supported public API for directly sending to or mirroring this actual Dot conversation has not been established. Do not present Sign in with ChatGPT, Codex app-server, or generic Responses API inference as Dot conversation access. Full Dot-as-a-provider inside the J1 composer remains a separate integration gap until a supported messaging route is verified.

## Remaining account/runtime proof

The plugin route is documented and the connection UI is present. Platform tunnel access, an authenticated tunnel, the scoped J1 adapter, actual Dot discovery/tool invocation, and round-trip task result delivery are not yet implemented or tested. No new third-party tunnel dependency, public ingress, or model API billing has been enabled.
