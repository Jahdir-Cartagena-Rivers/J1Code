import {
  isRuntimeModeAbove,
  type BotProfile,
  type OrchestrationV2InternalCommand,
  type ProjectId,
  type RuntimeMode,
} from "@j1code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { MausbotNativeProofError } from "./MausbotNativeProofError.ts";
import type { SavedNativeBotEnrollment } from "../mausbot/NativeBotEnrollment.ts";

type Create = Extract<OrchestrationV2InternalCommand, { type: "thread.bot.create" }>;

export const nativeBotRuntimeMode = (mode: SavedNativeBotEnrollment["approvalMode"]): RuntimeMode =>
  mode === "full" ? "full-access" : mode === "auto" ? "auto" : mode === "edits"
    ? "auto-accept-edits" : "approval-required";

export interface MausbotProjectOverrideProof {
  readonly command: Create;
  readonly nativeBotId: string;
  readonly nativeThreadId: string;
  readonly defaultProjectId: ProjectId;
  readonly workspaceRoot: string;
  readonly restrictedTools: boolean;
  readonly current: () => boolean;
  readonly read: Effect.Effect<SavedNativeBotEnrollment | null, MausbotNativeProofError>;
}

/** A server-only effect capability. No command schema accepts it. */
export const MausbotProjectOverride = Context.Reference<MausbotProjectOverrideProof | undefined>(
  "@j1code/server/orchestration-v2/MausbotProjectOverride",
  { defaultValue: () => undefined },
);

export function matchesMausbotProjectOverride(
  proof: MausbotProjectOverrideProof,
  command: Create,
  profile: BotProfile,
  saved: SavedNativeBotEnrollment | null,
): boolean {
  return proof.command === command &&
    proof.current() &&
    command.creationSource === "server" &&
    command.botId === `mausbot:${proof.nativeBotId}` &&
    command.threadId === `j1-mausbot:${proof.nativeBotId}:${proof.nativeThreadId}` &&
    profile.id === command.botId &&
    !profile.archived &&
    profile.projectId === proof.defaultProjectId &&
    command.projectId !== proof.defaultProjectId &&
    saved !== null &&
    saved.botId === proof.nativeBotId &&
    saved.threadId === proof.nativeThreadId &&
    saved.projectId === proof.defaultProjectId &&
    saved.threadProjectId === command.projectId &&
    saved.modelSelection.instanceId === profile.modelSelection.instanceId &&
    saved.modelSelection.model === profile.modelSelection.model &&
    saved.defaultVariant === profile.modelSelection.options?.find(row => row.id === "variant")?.value &&
    saved.threadSelection.instanceId === command.modelSelection.instanceId &&
    saved.threadSelection.model === command.modelSelection.model &&
    saved.threadVariant === command.modelSelection.options?.find(row => row.id === "variant")?.value &&
    !isRuntimeModeAbove(command.runtimeMode, nativeBotRuntimeMode(saved.approvalMode)) &&
    (!saved.restrictedTools || proof.restrictedTools);
}
