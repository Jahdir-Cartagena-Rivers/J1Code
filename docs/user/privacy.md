# Privacy and your data

J1 Code is an independently maintained, local-first coding workspace. It does not include an account for a maintainer-operated cloud service. Configure your own providers and optional services.

## Local information

Projects, conversations, Hive Mind memories, imported history, and connection settings are stored in the environment that hosts your server. Provider authentication stays in the configured provider or runtime credential store. Back up your profiles before removing them, and keep databases, credentials, and pairing links out of public repositories.

## Information sent to services

Your chosen coding providers receive the prompts, files, and tool results you send them. Connected clients can access the environments you authorize. Optional J1 Connect, notification, relay, and diagnostic features communicate with the services configured for that build. Each service's own terms and privacy policy apply.

Cloud and telemetry fields in `.env.example` are blank. Review your build configuration before enabling a service. Public configuration is included in client bundles; it must never contain a server secret.

## Your choices

Use direct local or LAN connections when you do not need cloud linking. Disconnect environments, sign out of optional services, or remove their configuration when you no longer need them. Disable history import or remove memories through Hive Mind when you do not want that information retained there. Signing out does not delete your local conversations or project files.

See [remote access](remote-access.md), [Hive Mind](hive-mind.md), and [open source licenses](open-source-licenses.md) for related controls and attribution.
