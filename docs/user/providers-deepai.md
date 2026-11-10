# DeepAI

Add **DeepAI** in **Settings > Providers**, then choose **Import DeepAI Code account**.
Sign in to the DeepAI Code desktop app on the machine hosting your J1 environment
before importing. The import copies the account credential into J1's protected
server credential store; it does not change DeepAI Code's settings or history.
Remote clients use the account on their connected server.

Refresh provider status to load DeepAI's current models. Model availability and
allowances are controlled by DeepAI and your account. A listed model can still
require a subscription or additional allowance. J1 cannot independently verify
the identity of models served by DeepAI.

DeepAI supports text coding turns and J1 tools. Restricted permission modes ask
before tool execution. Auto uses the same approval path as Supervised. Full
Access permits tools without those approval prompts.

Start a new thread to change models. Image attachments, Plan mode, native
conversation rollback, and manual compaction are not currently supported by this
provider. Signing out in J1 removes J1's credential; DeepAI Code remains signed in.
