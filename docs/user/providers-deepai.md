# DeepAI

Add **DeepAI** in **Settings > Model providers**, then choose **Import DeepAI Code account**.
Sign in to the DeepAI Code desktop app on the machine hosting your J1 environment
before importing. The import copies the account credential into J1's protected
server credential store; it does not change DeepAI Code's settings or history.
Remote clients use the account on their connected server. Import does not open a
sign-in window.

Refresh provider status to load DeepAI's current models. Model availability and
allowances are controlled by DeepAI and your account. A listed model can still
require a subscription or additional allowance. J1 cannot independently verify
the identity of models served by DeepAI.

Bots can select **DeepAI** in their model picker after an account is connected.
They keep their normal tools and approval settings. Models that require the
Responses API are available to J1 chats, but are omitted from the bot picker.

If DeepAI reports a daily connection check-in limit, wait for its reset; signing
in again does not clear that limit.

DeepAI supports text coding turns and J1 tools. Restricted permission modes ask
before tool execution. Auto uses the same approval path as Supervised. Full
Access permits tools without those approval prompts.

Start a new thread to change models. Image attachments, Plan mode, native
conversation rollback, and manual compaction are not currently supported by this
provider. Signing out in J1 removes J1's credential; DeepAI Code remains signed in.
