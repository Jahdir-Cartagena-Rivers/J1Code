# Install J1 Code

J1 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch J1 Code and configure providers afterwards.

## Windows desktop

Download the Windows x64 installer from [J1 Code Releases](https://github.com/Jahdir-Rivers/J1Code/releases/latest). Current releases are unsigned. Verify the published checksums before installing, then authenticate your provider CLIs on the machine that runs your agents.

Use the installer for in-app updates. Portable builds are for manual installation and have no update feed. J1 keeps its own profile separate from T3 Code.

## Source and other platforms

Build J1 from this repository using the [development runbook](../operations/development.md) and [fork maintenance guide](../operations/j1-fork.md). macOS, Linux, web, and mobile sources are included; published J1 desktop releases currently target Windows x64. Mobile builds need your own signing and Expo configuration.

The `t3` binary and protocol names are retained in J1 builds. Official `npx t3`, winget, Homebrew, and `t3.codes` installers distribute upstream T3 Code. To run J1's server, use your source build or the matching runtime archive from a J1 release.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. J1 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

J1 mobile source is included, but no branded J1 release is currently published to the app stores. Build it using the [mobile setup guide](../../apps/mobile/README.md) with your own signing and Expo configuration, then pair it with your J1 server. Official T3 mobile clients are separate products; compatibility with this J1 base still needs device validation.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from J1 Code's provider settings.                                                                                         |

Provider CLIs must be on the server's `PATH`. If J1 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

J1 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when J1 Code can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, J1 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating J1 Code](./updating.md): update the app and connected servers.
