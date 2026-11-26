import {
  OrchestrationDispatchCommandError,
  OrchestrationV2ThreadLaunchError,
} from "@j1code/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isThreadLaunchError = Schema.is(OrchestrationV2ThreadLaunchError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    (isOrchestrationDispatchCommandError(error) || isThreadLaunchError(error)) &&
    error.bootstrapThreadDisposition === "not-created"
  );
}
