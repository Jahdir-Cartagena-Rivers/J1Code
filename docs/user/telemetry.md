# Product usage data

The J1 Code server sends product usage events to PostHog at `us.i.posthog.com` by default,
associated with a hashed account or installation identifier. Events include the provider, model,
reasoning effort, permission mode, turn and request results, duration, release channel, and token
counts when available. Child-agent token counts are reported separately from the main agent's.
Model names are sent only when they appear in a provider's public model list.

Additional account and device observations require explicitly setting
`T3CODE_TELEMETRY_ENABLED=true`. These observations use hashed identifiers for your J1 Connect,
OpenAI, and Claude accounts and connecting devices. A managed policy or desktop shell opt-out
still disables them.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

## Relay connection diagnostics

J1 Code sends relay connection traces to Axiom to diagnose J1 Connect connectivity. These are
separate from product events. Depending on the client version, traces can include connection
timings, environment identifiers and the connected machine's name. Failed spans can include error
messages and stack traces; error text can quote a value the app was handling.

Set `DO_NOT_TRACK=1` or `T3CODE_TELEMETRY_ENABLED=false` in the server environment before starting it
to disable product events and relay tracing. CI runners default to disabled and can opt in with
`T3CODE_TELEMETRY_ENABLED=true`. Relay tracing also stops when `T3CODE_OTEL_SDK_DISABLED` or
`OTEL_SDK_DISABLED` turns OpenTelemetry export off.

An administrator can turn product events and relay tracing off in the server and desktop app with
a [managed policy](./managed-policy.md#other-capabilities). This does not control traces sent by
separate browser or mobile clients.

The desktop app reads `DO_NOT_TRACK` and `T3CODE_TELEMETRY_ENABLED` from your shell profile on macOS
and Linux. Export your preference there and restart the app. On Windows, set it as a user
environment variable or in your PowerShell profile.

The web app in a browser, including one the `j1` CLI opens, does not read these environment
variables. When its build has relay tracing configured, it sends its own connection traces even
if the server has opted out. The browser app has no relay tracing toggle.

## Mobile app diagnostics

When the iOS or Android app crashes or hits an error, it sends a report to T3 Code: the error
message, the stack trace, the app version, and the device model and OS version. Each launch also
sends startup timings, and every report carries a random ID for the install. Reports go through
the T3 Connect relay to Axiom. They do not include your threads, prompts, or connection details,
but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About J1 Code > Diagnostics**.

The mobile app also sends relay connection traces when its build has tracing configured. These
carry an identifier for the current app session. **Send crash reports** does not control these
traces, and the mobile app has no separate relay tracing toggle. Server environment variables and
managed policy do not disable mobile tracing.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the J1 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
