# J1 background server on Windows

Packaged Windows J1 Code keeps its native local server running when you close or quit the desktop. Reopening reconnects to that same server, port, chats, and provider sessions. The computer must remain awake and connected; signing out of Windows, rebooting, or shutting down ends the processes. This does not install a boot service or scheduled task.

The first launch copies the packaged runtime into your J1 home under `background/runtimes/`. This copy includes Electron, the backend, and native modules so portable extraction cleanup and desktop updates cannot remove a running server's files. Each version remains immutable. An updated desktop reconnects to the running backend version. Backend changes and launch settings take effect after stopping the old server and launching again; incompatible future client/server protocol changes must retain compatibility or require a coordinated restart.

Use **File > Background Server…** to inspect the running version. **Stop server and quit** ends ongoing chats and provider descendants; launch J1 again to start the current backend version. Ordinary Quit keeps the server running. The host shuts down if the server exits unexpectedly; reopening the desktop starts it again. Logs and private local control state are in `background/server.log` and `background/server.json`; do not share the control state, which contains local pairing credentials.

The server uses its existing authentication and exposure settings. No public listener or tunnel is enabled by this feature. A protected local named pipe is used for status and stop; the host terminates only its own captured child tree. Invalid or unknown state and an orphaned live server fail closed rather than launching another database writer.

This slice covers the packaged native Windows primary backend. Development builds, WSL backends, and macOS/Linux desktops keep their existing lifecycle. Existing Linux/macOS CLI services remain available. Desktop-only tools, including the collaborative browser and computer interaction, require the desktop to be open; provider work and server-owned tools can continue after it closes.

When upgrading from an older release whose server is owned by the desktop, finish or interrupt existing turns before closing it for the first upgrade. The old release cannot hand an already-running turn into the new detached host.
