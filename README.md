<p align="center">
  <img src="assets/j1/icon.svg" width="96" alt="J1 Code logo" />
</p>

<h1 align="center">J1 Code</h1>

<p align="center">A local workspace for coding agents, shared memory, and work across providers.</p>

<p align="center">
  <a href="https://github.com/Jahdir-Rivers/J1Code/releases">Downloads</a> ?
  <a href="docs/README.md">Documentation</a> ?
  <a href="CONTRIBUTING.md">Contributing</a> ?
  <a href="LICENSE">License and permissions</a>
</p>

J1 Code brings your coding providers into one desktop, web, and mobile workspace. Use your own provider accounts, keep your projects and conversations on your machine, and coordinate work across configured agents.

Built on [T3 Code](https://github.com/pingdotgg/t3code), with its architecture and MIT attribution preserved. J1 is an independently maintained derivative, based on upstream **0.0.44**. It is not an official T3 Tools release.

## What J1 adds

| Feature                 | What it does                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Shared Hive Mind        | Remember, recall, correct, and forget facts across provider chats and projects.                              |
| Agent delegation        | Give bounded tasks to workers on configured providers and models; inspect their saved chats and results.     |
| Saved history import    | Refresh Claude Code and Codex conversations from local transcripts, including supported compacted histories. |
| Live external history   | Follow new saved messages while an external session continues.                                               |
| Windows background work | Keep the server and active agent work running when the desktop closes to the tray.                           |
| Separate profiles       | Keep J1 desktop and server data separate from your T3 installation.                                          |

Provider adapters include Codex, Claude Code, Cursor, Grok, OpenCode, and Antigravity. Availability and capabilities depend on the provider runtime installed and authenticated on your machine.

## Get started

1. Download the Windows x64 installer from [Releases](https://github.com/Jahdir-Rivers/J1Code/releases/latest). Current releases are unsigned; verify the published checksums before installing.
2. Install and authenticate the coding provider you want to use.
3. Open J1 Code, add your project, and configure your providers in Settings.

Windows is the currently published desktop target. The source includes macOS, Linux, web, and mobile clients; those targets need their own builds and validation. Mobile distribution requires your own signing and Expo configuration. See [installation](docs/user/install.md) and [fork maintenance](docs/operations/j1-fork.md).

## Build from source

These commands are for maintainers, separately authorized development, or MIT material. Building or modifying new protected J1 source requires permission under [the current terms](LICENSE); the earlier MIT versions retain their original permissions.

Use Node.js **24** within the version range in [package.json](package.json), and the repository's pinned pnpm/Vite+ tooling.

### Install vp

Install Vite+ using its [official setup instructions](https://viteplus.dev/guide/). Then, from your clone:

```sh
git clone https://github.com/Jahdir-Rivers/J1Code.git
cd J1Code
vp i
vp run dev
```

Use the pairing URL printed by the dev runner to connect. To build the desktop client:

```sh
vp run build:desktop
vp run dist:desktop:win:x64
```

Packaging prerequisites, portable builds, and the optional embedded WSL runtime are covered in [fork maintenance](docs/operations/j1-fork.md). Development commands and isolated test data are in the [development runbook](docs/operations/development.md).

## Bring your own configuration

Local use does not require a cloud service account. Authenticate providers through their own CLIs and configure local or LAN connections in J1.

For optional cloud sign-in, a self-hosted relay, or desktop updates, copy [.env.example](.env.example) to `.env` and fill in your own values. Relay server credentials belong in the relay deployment's environment; see [infra/relay/.env.example](infra/relay/.env.example). Mobile builds use your own `J1CODE_*` signing and Expo identifiers.

Desktop update feeds are opt-in when building. Set `T3CODE_DESKTOP_UPDATE_REPOSITORY=your-owner/your-repository`; set `T3CODE_DESKTOP_UPDATE_PRIVATE=true` only for a private feed. Provider tokens, GitHub credentials, pairing tokens, and user memories are runtime data, not release configuration to commit.

J1 stores desktop preferences under `%APPDATA%/j1code` on Windows and server state under `~/.j1`. Keep these profiles, transcripts, memory exports, and `.env` files private. [Hive Mind](docs/user/hive-mind.md) starts with your own facts; imported personal memories are not part of the repository.

## Learn more

- [User guides](docs/README.md): providers, permissions, projects, connections, and source control.
- [Hive Mind](docs/user/hive-mind.md): shared memory and corrections.
- [Windows background server](docs/user/j1-background-server.md): tray and shutdown behavior.
- [Maintenance and releases](docs/operations/j1-fork.md): builds, upstream updates, and migration.
- [Security policy](.github/SECURITY.md): reporting a vulnerability.

## Attribution

J1 Code is source-available. [Current terms](LICENSE) reserve rights in new protected J1 material while allowing use of official builds. T3 Code, dependencies, and previously released J1 material retain their original licenses, including MIT. See [the licensing boundaries](LICENSING.md). Full upstream copyright and third-party notices ship with the application. The `T3CODE_*` configuration names, `t3` CLI, and shared wire protocol remain for compatibility.
