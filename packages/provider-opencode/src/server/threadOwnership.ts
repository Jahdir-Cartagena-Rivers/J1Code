import type {
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ThreadId,
} from "@j1code/contracts";

/** A runtime can host several conversations, but a native ID cannot change owners. */
export function ownsOpenCodeThread(
  instanceId: ProviderInstanceId,
  thread: OrchestrationV2ProviderThread,
  appThreadId?: ThreadId,
  attached?: OrchestrationV2ProviderThread,
): boolean {
  return (
    thread.driver === "opencode" &&
    thread.providerInstanceId === instanceId &&
    (thread.nativeThreadRef == null || thread.nativeThreadRef.driver === "opencode") &&
    (appThreadId === undefined || thread.appThreadId === appThreadId) &&
    // A new provider record can represent the same native history for another run.
    (attached === undefined || thread.appThreadId === attached.appThreadId)
  );
}
