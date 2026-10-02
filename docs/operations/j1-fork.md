# Maintaining J1 Code

The local `j1-code` branch starts from T3 Code 0.0.44, upstream commit `c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21`. The `upstream` remote points to `pingdotgg/t3code`. Add an `origin` remote after creating your GitHub fork; this checkout does not imply a published repository.

## Upstream updates

Commit local work, fetch `upstream`, inspect its changes, then merge the selected upstream commit on a maintenance branch. Resolve conflicts in the importer, history decider, sidebar footer, branding, and packaging. Keep fork versions suffixed `-j1.N`. Build and validate before publishing a versioned J1 release. Git pushes alone never trigger desktop updates.

The wire protocol, provider names, `T3CODE_*` environment variables, `t3.json` project files, and existing URL schemes are retained for compatibility. Product names, marks, desktop identity, and default data directories use J1. Upstream legal attribution is retained.

## Build

Install the existing locked dependencies with the repository's configured pnpm version. Generate J1 artwork with `node scripts/export-j1-icons.mjs`, then run `pnpm exec vp run build:desktop`. For an updateable Windows release, build the `nsis` target with `pnpm exec vp run dist:desktop:artifact --platform win --target nsis --arch x64 --skip-build --keep-stage --wsl-runtime <matching-linux-archive>`. Publish the installer, its blockmap, and `latest.yml` together on the private `Jahdir-Rivers/J1Code` GitHub release. Keep the release marked as a production release, not a prerelease. The portable target remains available for manual installation and has no updater feed.

The installed NSIS build checks releases on startup and every four minutes. The bottom-left update control turns blue when a newer release is available; it downloads on the first click and installs/restarts on the second click after confirmation. The private repository requires the user's existing `gh auth login` credentials or a runtime `GH_TOKEN`/`GITHUB_TOKEN`; tokens are not packaged into releases. Install the first NSIS build manually once, because older portable builds have no update feed. Pin the stable Start-menu shortcut from that installation. Do not point a taskbar shortcut at a `versions/<version>` executable.

The embedded Linux archive must use the same J1 version and forked server. Build it with the existing `apps/server/scripts/cli.ts build-exe --target linux-x64` command under the pinned Node 26.8.2 tooling; archive it using `scripts/build-cli-archive.ts`. Preserve Linux executable permissions and native runtime dependencies.

The initial Windows artifact reuses the installed upstream 0.0.44 resource-monitor binary, unchanged. Its Linux archive reuses the matching upstream native dependency tree and resource monitor, replacing the server executable and complete web client with J1 builds. WSL runtime behavior still needs a real WSL distribution to validate.

Run targeted history/import, identity, branding and Windows packaging tests, relevant typechecks, and lint. Do not run a server against the original `~/.t3/userdata` database. Use a consistent read-only SQLite snapshot for validation.

## Existing data

Copy a consistent SQLite snapshot and preferences into a new `~/.j1/userdata` directory before first launch. Include attachments and themes if present. Do not overwrite an existing J1 profile. Preserve the original T3 install and data. Connection identities and credentials should be regenerated, so pair remote clients with J1 again.

The official mobile client remains T3 branded. A custom J1 mobile binary needs its own signing configuration (`J1CODE_APPLE_TEAM_ID`, `J1CODE_EAS_PROJECT_ID`, `J1CODE_EXPO_OWNER`) and service registration for any cloud sign-in, notifications or app links. The fork's mobile OTA updater is disabled. No mobile release is included in the initial Windows build.
