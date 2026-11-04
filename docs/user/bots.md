# Bots

Use **Bots** above Chats to keep reusable agents with their own instructions and model. Choose **Add bot**, select a project and a configured model, and save. Pinning is optional.

Select a bot to reopen its latest active conversation. Use its **New conversation** action to start another. Each conversation keeps the instructions it started with; editing the reusable bot changes future conversations. Archive a bot to hide it, then show archived bots to restore it. Existing conversations remain available in their projects.

Bots use the selected project's normal workspace and approval settings. Their model and connected tools run on that project's environment, including when you connect from web or mobile.

## Background browser

Install a compatible native Lightpanda executable on the J1 server. In **Settings → Integrations → Browser → Background browser**, leave the field blank to use the bundled Windows browser, enter a custom executable path to override it, or enter `disabled` to turn it off. On servers without a bundled browser, install Lightpanda and enter its full path. Enable **Agent browser access** for the project and start a new agent session to apply that permission.

Agents can discover the browser with `background_browser_tools`, use its advertised tools through `background_browser_call`, and release it with `background_browser_close`. Each provider session gets a separate temporary browser; idle sessions close automatically. Cookies and page state are separate from the visual browser. Use the collaborative browser for visual inspection and recordings.
