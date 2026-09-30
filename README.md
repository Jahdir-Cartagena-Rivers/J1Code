# J1 Code

J1 Code is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code), based on upstream **0.0.44**, commit c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21. Upstream authors and MIT licensing are retained.

The sidebar footer's circular-arrow button **refreshes saved Claude Code and Codex history** across your existing projects. It imports new conversations and appends new saved messages to previously imported conversations. **Live external chat viewing** is enabled by default and follows saved messages automatically while the external session continues. Toggle it in Settings → General. Long and compacted conversations preserve their saved history; ambiguous, rewritten or truncated histories and chats continued inside J1 are skipped.

J1 Code uses separate desktop and server profiles: %APPDATA%/j1code and ~/.j1. Fork release versions use the -j1.N suffix and omit the automatic desktop update feed. Upstream updates are merged and built manually.

The server retains the T3 wire protocol and history events. Official T3 mobile/web clients are expected to remain compatible with this base version; phone and relay behavior still require device validation. A separately branded mobile build uses its own app identifiers and no upstream OTA feed. Publishing it requires your own signing and Expo configuration.

## Run and maintain

Use the locally built Windows portable executable in release/. It does not replace your installed T3 Code. See [fork maintenance](docs/operations/j1-fork.md) for builds, upstream updates, and data migration.

Configure and authenticate your existing coding providers before starting agent work. Refresh history only reads saved transcripts; it does not invoke a model.

User guides: [project settings](docs/user/project-settings.md), [permissions](docs/user/permission-modes.md), and [remote access](docs/user/remote-access.md).
