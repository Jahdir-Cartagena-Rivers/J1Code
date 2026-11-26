import { Context } from "effect";
import type { ReadSavedNativeBotEnrollment, ReadSavedNativeRoomMemberEnrollment, StageSavedColdRoomTurn } from "./NativeBotEnrollment.ts";

/** Parent-private identity for one native runtime generation. */
export interface MausbotExecutionOwner {
  readonly id: string;
}

/** Native bot transport contract, independent of either orchestration implementation. */
export class MausbotExecutionHost extends Context.Service<
  MausbotExecutionHost,
  {
    readonly call: (
      input: unknown,
      current: () => boolean,
      emit: (event: unknown) => void,
      owner: MausbotExecutionOwner,
      /** Parent-private capability; never part of the decoded native turn input. */
      readEnrollment?: ReadSavedNativeBotEnrollment,
      readRoomEnrollment?: ReadSavedNativeRoomMemberEnrollment,
      stageRoomTurn?: StageSavedColdRoomTurn,
    ) => Promise<unknown>;
    readonly disconnect: (owner: MausbotExecutionOwner) => Promise<void>;
  }
>()("@j1code/server/mausbot/ExecutionHost/MausbotExecutionHost") {}
