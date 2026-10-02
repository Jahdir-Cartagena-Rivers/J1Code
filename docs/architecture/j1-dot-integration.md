# Connect the actual ChatGPT Dot to J1

The target is the user's existing ChatGPT Dot. Keep its identity, memory, cloud computer, and conversation in ChatGPT. A new Codex coordinator or an API model with similar instructions would not be the same Dot.

## Plugin transport

[Dot computer/app documentation](https://learn.chatgpt.com/docs/dots/computers-and-apps) explicitly says Dots can use supported installed plugins. Connect a private MCP plugin using **Tunnel** and OAuth to give Dot access to J1 tools.

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) lets a local tunnel client make an outbound HTTPS connection to OpenAI and forward MCP requests to a private local server. It requires a Platform tunnel, runtime API key, tunnel permissions, and association with the correct ChatGPT workspace. It supports private developer-mode use, not public plugin distribution. This transport still requires the PC/server to be online; Dot's cloud computer does not keep J1's local provider processes alive when the PC shuts down.

## Connection boundary

The local adapter uses a separate `/dot/mcp` endpoint and durable connection identity. Its credential is revealed once; only its hash is stored. The authenticated Connections settings controls project read access and task creation independently, with an explicit worker permission mode and expiry. Provider credentials and the desktop bootstrap credential are never handed to Dot.

The adapter reuses the worker lifecycle behind provider delegation, while allowing a saved Dot coordinator without a running provider session. Grants are checked on each call. Durable request reservations and payload fingerprints keep retries attached to the same worker; a conflicting payload rejects. Workers retain normal approvals, deadlines, quotas, and descendant cancellation. Results are bounded and use the persisted chat's history cursor. Restart recovery preserves work and marks incomplete tasks interrupted instead of replaying them.

Plugin OAuth uses its own authorization-code + S256 PKCE flow over the prepared connection grants. Existing J1 sign-in gates consent, which is bound to the initiating J1 session and checks the form Origin. Access tokens last at most an hour; rotating refresh tokens expire with the connection, and refresh replay revokes that token family. Both are stored only as hashes and checked against the current setup and connection on use. A predefined public client and exact callback/resource bindings keep this independent from environment bootstrap token exchange.

OAuth issuer reachability remains a deployment requirement. Browser authorization remains direct; registered metadata and token endpoints can pass through the official tunnel's Harpoon shim. A private HTTPS origin can serve browser sign-in while the OpenAI tunnel relays token exchange and MCP traffic. ChatGPT's advanced OAuth settings retain the upstream issuer and resource identities while using the discovered tunnel token endpoint. The configured resource can have a different origin from the issuer; discovery challenges refer to the resource origin. Do not force both identities to the same URL or assume tunnel rewriting preserves the upstream resource unchanged. Consent must allow the configured callback origin in its form-action policy because Chromium checks the form redirect as well as its initial destination.

Existing `/mcp` tokens are scoped to active J1 provider sessions and parent chats. Reusing one for Dot would couple Dot's permissions to an unrelated chat and fail when that session changes. A tunnel alone does not fix that engineering gap.

## Chat and coordination boundary

The primary conversation experience is a dedicated view of the existing Dot chat in J1 desktop. It reuses the thread-owned browser surface and its environment/profile partition so it retains the real ChatGPT login and conversation, without an iframe, copied credentials, or a replacement agent. The saved conversation/profile is device-local and environment-scoped; web clients open the link in ChatGPT. The ordinary chat path does not invoke J1 workers.

Dot can additionally coordinate Claude/Codex and other J1 agents by calling the plugin; J1 stores those worker chats and results. Voice, personality settings, Dot memory, and the original Dot conversation continue to live in ChatGPT.

Hive Mind access uses separate read/write connection grants and OAuth scopes. The plugin's recall, remember and forget tools use the same environment-owned store as provider Hive Mind tools, directly, without a worker or fabricated provider session. Old connections default to no memory permission; an old OAuth token cannot inherit new scopes. Tool metadata and an OAuth challenge request explicit reconnection when additional scopes are needed. Memory writes carry the stable Dot connection identity as their source. The grants cover the shared store across projects, so consent must make this broader access clear; project chat grants do not constrain memory search. Hindsight and ChatGPT's own memory remain independent.

Effect's tool metadata is exported under `_meta`; the Dot HTTP adapter mirrors `securitySchemes` to the top level of tool discovery for ChatGPT. An existing plugin may retain its original default OAuth scopes after refreshing tools or reconnecting. Check the requested scopes on J1's consent page. If incremental scope upgrade does not work, configure a separate private Hive Mind plugin with explicit memory scopes; do not silently widen an existing token's permissions.

A supported public API for directly sending to or mirroring this actual Dot conversation has not been established. Do not present Sign in with ChatGPT, Codex app-server, or generic Responses API inference as Dot conversation access. Full Dot-as-a-provider inside the J1 composer remains a separate integration gap until a supported messaging route is verified.
