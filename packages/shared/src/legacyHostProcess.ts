// Keep J1 callers on the same injected references as upstream's renamed module.
// Separate filename avoids a hostProcess.ts/HostProcess.ts collision on Windows.
export {
  Platform as HostProcessPlatform,
  Architecture as HostProcessArchitecture,
  Hostname as HostProcessHostname,
  Environment as HostProcessEnvironment,
  WorkingDirectory as HostProcessWorkingDirectory,
  ExecutablePath as HostProcessExecutablePath,
  Arguments as HostProcessArguments,
  InvokedAs as HostProcessInvokedAs,
  IsExecutable as HostProcessIsExecutable,
  Addresses as HostProcessAddresses,
  UserId as HostProcessUserId,
  isWindows as isHostWindows,
} from "./HostProcess.ts";
