# Maintaining J1 Code

J1 Code starts from T3 Code 0.0.44, upstream commit `c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21`. Keep `upstream` pointed at `https://github.com/pingdotgg/t3code.git` and use your own standalone repository as `origin`.

## Upstream updates

Commit local work, fetch `upstream`, inspect its changes, then merge the selected upstream commit on a maintenance branch. Resolve conflicts in history import, delegation, Hive Mind, branding, and packaging. Keep fork versions suffixed `-j1.N`. Push accepted changes to `j1-code` to start the automatic release pipeline.

The wire protocol, provider names, `T3CODE_*` environment variables, `t3.json` project files, and existing URL schemes are retained for compatibility. Product names, marks, desktop identity, and default data directories use J1. Upstream legal attribution is retained.

## Build

Install the locked dependencies with `vp i`, then run `vp run build:desktop`. J1 artwork is already tracked; regenerate it with `node scripts/export-j1-icons.mjs` when changing the artwork.

For a Windows installer:

```sh
vp run dist:desktop:artifact --platform win --target nsis --arch x64 --skip-build
```

For a manual portable build, use `--target portable`. Packaging requires the Windows prerequisites in the [development runbook](development.md). The artifact builder builds the resource monitor unless explicitly reusing a compatible existing binary.

Desktop files include the version, platform, and architecture. Windows installer and portable names end in `-setup.exe` and `-portable.exe`, respectively. The embedded Linux CLI archive retains its `t3-<version>-linux-x64.tar.gz` name for runtime compatibility.

### Automatic Windows releases and updates

The [J1 Windows release workflow](../../.github/workflows/j1-release.yml) runs on every push to `j1-code`, or by manual dispatch on that branch. It runs focused J1 regressions, builds and smoke-tests the matching Linux runtime, then builds and validates the Windows x64 NSIS installer. Versions use the checked-in J1 revision plus the workflow run number; package versions change only in the build checkout, so version bumps do not create recursive pushes. Keep the workflow file and its run counter when maintaining this pipeline.

Publication verifies installer/version/checksums and uses a draft until all assets are present. A superseded commit cannot publish. Failed builds preserve the prior published release, and a retry cannot replace an already published release. The pipeline preserves the private repository and embeds its authenticated update feed. It uses the repository's short-lived Actions token only for publication; no runtime token is embedded. Installers remain unsigned until signing is configured.

Older builds configured with a public feed cannot read a private repository. Install one new private-feed installer to transition those builds; subsequent releases appear through the app's update control after GitHub CLI sign-in.

A source build has no update feed unless configured. In your untracked root `.env`, set:

```dotenv
T3CODE_DESKTOP_UPDATE_REPOSITORY=your-owner/your-repository
T3CODE_DESKTOP_UPDATE_PRIVATE=false
```

GitHub Actions can use its own `GITHUB_REPOSITORY` as the fallback. For a private repository, set `T3CODE_DESKTOP_UPDATE_PRIVATE=true`. Users of private feeds authenticate through `gh auth login` or runtime `GH_TOKEN`/`GITHUB_TOKEN`; never embed a token in the package.

Publish the NSIS installer, its blockmap, and `latest.yml` together on a production GitHub release. Portable builds have no update feed. The installed app checks on startup and periodically; download and install through the sidebar update control. Older portable builds need a one-time manual installer transition.

Use the stable Start-menu shortcut from the installation. Do not point a taskbar shortcut at a `versions/<version>` executable.

### Optional WSL runtime

For WSL support, pass `--wsl-runtime <matching-linux-archive>` to Windows packaging. The archive must have the same J1 version and forked server. The [J1 Linux runtime workflow](../../.github/workflows/j1-linux-runtime.yml) builds and smoke-tests it. Preserve Linux executable permissions and native dependencies. A real WSL distribution is still required for device-level validation.

Run focused history/import, identity, update-feed, and packaging tests plus relevant lint and typechecks. Do not run a server against a live profile; use isolated state.

## Existing data

Copy a consistent SQLite snapshot and preferences into a new `~/.j1/userdata` directory before first launch. Include attachments and themes if present. Do not overwrite an existing J1 profile. Preserve the original T3 install and data. Regenerate connection identities and credentials, then pair remote clients with J1 again.

## Mobile and cloud services

A custom J1 mobile binary needs its own signing configuration (`J1CODE_APPLE_TEAM_ID`, `J1CODE_EAS_PROJECT_ID`, `J1CODE_EXPO_OWNER`) and service registration for cloud sign-in, notifications, or app links. The fork's mobile OTA updater is disabled.

The retained upstream release/deployment workflows are reference tooling for the T3 npm, relay, signing, and app-store infrastructure. J1's dedicated Windows pipeline operates independently of them. Configure your own services, runners, package namespaces, and repository secrets before adapting upstream workflows; they do not publish a complete J1 release as-is. Upstream fork release/deployment jobs stay disabled unless you explicitly set the repository variables `J1CODE_ENABLE_UPSTREAM_RELEASES=true` or `J1CODE_ENABLE_UPSTREAM_DEPLOYMENTS=true`, respectively.
