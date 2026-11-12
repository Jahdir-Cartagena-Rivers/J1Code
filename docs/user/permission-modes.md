# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Uses broad access; provider-required confirmations can still appear.                  |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, and Cursor; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking.

For Grok, **Always allow this session** remembers the matching command or tool input. Other
actions still require approval.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Codex, including Codex-powered bots, uses no-prompt execution in **Full access**, with full filesystem
access. Provider hard denials can still reject an action; they are reported as failures rather than
converted into approval requests.

In Codex **Full access**, J1's built-in tools use the session's granted access without another
per-call app approval. Other permission modes automatically allow read-only J1 tools and retain
approval for actions that change state. Project instructions and browser-use permissions still apply.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
