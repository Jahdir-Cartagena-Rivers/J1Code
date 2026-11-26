# Install J1 Code

J1 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch J1 Code and configure providers afterwards.

## Windows desktop

Download the Windows x64 installer from [J1 Code Releases](https://github.com/Jahdir-Cartagena-Rivers/J1Code/releases/latest). Current releases are unsigned. Verify the published checksums before installing, then authenticate your provider CLIs on the machine that runs your agents.

Use the installer for in-app updates. Portable builds are for manual installation and have no update feed. J1 keeps its own profile separate from T3 Code.

## Source and other platforms

Build J1 from this repository using the [development runbook](../operations/development.md) and [fork maintenance guide](../operations/j1-fork.md). macOS, Linux, web, and mobile sources are included. Mobile builds need your own signing and Expo configuration.

Use a J1 source build or a matching runtime archive from [J1 Code Releases](https://github.com/Jahdir-Cartagena-Rivers/J1Code/releases). Choose an archive for your machine only when that release provides one. The standalone installer scripts in this repository use J1 releases, verify checksums, and keep data under `.j1` by default. `T3CODE_HOME` selects a different home; `T3CODE_VERSION` pins an exact release.

The `t3` command and protocol names are retained for compatibility. Official `npx t3`, `t3.codes` installers, winget, Scoop, Homebrew, AUR, and nixpkgs packages named T3 Code distribute upstream T3 Code. They do not install J1. For those upstream packages, follow the [upstream installation guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md) and update through the package manager that owns them.

### Standalone command

After installing a J1 runtime, its `t3` command supports these tasks:

| Task | Command |
| --- | --- |
| Start the server and open the web app | `t3` |
| Start without opening a browser | `t3 serve` |
| Connect from another device | `t3 up` ([remote access](./remote-access.md)) |
| Keep running in the background | `t3 service install` ([background service](./background-service.md)) |
| Update an installed release runtime | `t3 update` |
| Reclaim database space | `t3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove the runtime and launcher, keeping user data | `t3 uninstall` |

The installer places the command in `~/.local/bin` unless you set `T3CODE_INSTALL_BIN_DIR`. Follow its PATH instructions for your shell. It leaves an existing command it does not own alone. On Windows, add the folder to your saved PATH for future terminals.

Run `t3 help` or `t3 --help` for the full reference. To start in a new working directory, use an explicit path such as `t3 ./my-project`. A bare directory name is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, run the `t3 pair` command it names and open the pairing URL. Stop that server before starting a replacement, or use a different `--base-dir` for an independent server.

### Source-run servers and Intel Macs

If a release has no runtime for your platform, including Intel Macs, build from this repository using the development runbook. Update a source-run server with the corresponding source revision and rebuild; `t3 update` applies to standalone release runtimes. Keep its data directory separate from another installation.

### Other desktop packages

Use only a J1 package for your platform. For a Linux AppImage built from J1 source, make the downloaded file executable with `chmod +x` and run it. For a `.deb`, install the J1 package through your system package manager. Available formats and architectures depend on the release; check its asset names before downloading. Update manually built packages through the same build and installation workflow.

### The `t3` command

The desktop app includes the `t3` command-line tool. A new install sets it up
on first launch; after an update, or any time, choose **Install** next to
**t3 command** in **Settings → About**. On macOS and Linux it adds a `t3` link
in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command folder to
your `PATH`. Open a new terminal afterwards. If the folder is not on your
`PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds one
line to your shell's startup file. **Remove** takes it off, and the app does not
add it again. If you already have another `t3`, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
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

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer, the same as `t3 app`.
Files dropped on a thread still attach to that thread. Browsers do not share
folder paths, so in the web app use **Add project** instead.

## Mobile app

With an updated J1 server, mobile opens the same shared workspace as the web and desktop apps. In Settings → Connections → This device, you can manage the app's saved connections or return to its existing project and device tools. Older servers keep the native interface until the server is updated.

J1 mobile source is included, but no branded J1 release is currently published to the app stores. Build it using the [mobile setup guide](../../apps/mobile/README.md) with your own signing and Expo configuration, then pair it with your J1 server. Official T3 mobile clients are separate products; compatibility with this J1 base still needs device validation.

J1 mobile build-guide links and QR codes are available in **Settings → About → Mobile app**
on web and desktop, and on the Welcome page. Both phone platforms use the same source
build guide; these links do not install the separate upstream store apps.

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
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from J1 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

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
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when J1 Code cannot tell. Claude, Codex, and
OpenCode installs J1 Code cannot identify stay manual: update them through the
installer you used. J1 Code runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with J1 Code. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release J1 Code tested. When J1 Code finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, J1 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), [DeepAI](./providers-deepai.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Provider check timeouts

If a provider works in its CLI but J1 Code reports a timeout while checking it,
allow more time in the J1 server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3 serve
```

For a remote environment, set these on the machine running the J1 server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating J1 Code](./updating.md): update the app and connected servers.

- [Managed policy](./managed-policy.md): configure J1 Code for everyone on a machine.

## Move a server to another device

Open **Settings > Backup & transfer > Move this server** for copyable export and import commands.
The J1 server command creates an encrypted transfer file containing settings, bot configuration,
conversation history, attachments and credentials. Stop J1, its background service and managed bots
throughout the export. Import into a new home directory on the target and start it with
`j1 serve --base-dir NEW_HOME`. Keep the original server stopped because the restored server keeps its identity.

Keep the password file separate from the archive. Project repositories, provider installations and
external logins, machine services and network configuration need separate setup. Existing absolute
paths remain unchanged; machine-protected credentials may need signing in again.
