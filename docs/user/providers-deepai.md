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

DeepAI supports text coding turns, image attachments on image-capable models, file references, and J1 tools. Reasoning models expose Low, Medium, and High effort in the composer; the model service determines how those levels are applied. If DeepAI rejects an image despite listing image support, try another image-capable model or send text only. Restricted permission modes ask
before tool execution. Auto uses the same approval path as Supervised. Full
Access permits tools without those approval prompts.

Start a new thread to change models. Plan mode, native
conversation rollback, and manual compaction are not currently supported by this
provider. Signing out in J1 removes J1's credential; DeepAI Code remains signed in.


For models whose image backend is unavailable, the provider can use a local
Ollama vision interpreter. Set both `visionEndpoint` (for example,
`http://127.0.0.1:11434`) and `visionModel` in the DeepAI provider configuration.
The interpreter must already be running with a vision-capable model installed.
J1 sends it the images and your question, then gives DeepAI a labeled visual
report instead of unsupported image content. This supports visual observations
and text; report accuracy depends on the selected vision model. Remove both
settings to return to native DeepAI image delivery. Interpreter failures stop
the turn rather than silently omitting the images.
