# Desktop automation

Enable **Agent desktop access** in **Settings > Integrations**, then start a new
agent session. Projects can override the environment default. Turn it off and
start a new session to withdraw access.
Existing visual computer integrations retain their own permissions.

Agents can target native app controls through accessibility and take screenshots
to inspect layout or controls that accessibility cannot expose. Ask an agent to
reproduce a bug, fix it, and repeat the same workflow; logs, tests, and resulting
files remain part of verifying the fix.

Desktop automation operates the machine running the connected J1 server, including
when you connect from web or mobile. That machine needs an unlocked, signed-in
desktop. Windows elevated apps require matching privileges; macOS requires an
Accessibility grant. An unattended Linux or WSL server cannot operate the Windows
desktop through Linux accessibility.

Accessibility actions normally leave the pointer alone. Physical typing, dragging,
and coordinate input may take focus. Tell the agent whether it may interact with
your foreground desktop while you work.
