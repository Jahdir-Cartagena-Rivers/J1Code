import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import { ElectronApp } from "../../electron/ElectronApp.ts";
import {
  startWindowsDictation,
  cancelWindowsDictation,
  cancelAllWindowsDictation,
  stopWindowsDictation,
  getWindowsDictationText,
  getWindowsDictationLevel,
} from "../../voice/WindowsDictation.ts";

export const installDictationLifecycle = Effect.gen(function* () {
  const app = yield* ElectronApp;
  yield* app.on("before-quit", cancelAllWindowsDictation);
  yield* Effect.addFinalizer(() => Effect.sync(cancelAllWindowsDictation));
});

class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  message: Schema.String,
}) {}

const Request = Schema.Struct({
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export const startDictation = DesktopIpc.makeIpcMethod({
  channel: "desktop:dictation-start",
  payload: Request,
  result: Schema.String,
  handler: ({ requestId }) =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      return yield* Effect.tryPromise({
        try: () => startWindowsDictation(requestId, platform),
        catch: (cause) => new DictationError({ message: String(cause) }),
      });
    }),
});
export const cancelDictation = DesktopIpc.makeIpcMethod({
  channel: "desktop:dictation-cancel",
  payload: Request,
  result: Schema.Void,
  handler: ({ requestId }) => Effect.sync(() => cancelWindowsDictation(requestId)),
});
export const stopDictation = DesktopIpc.makeIpcMethod({
  channel: "desktop:dictation-stop",
  payload: Request,
  result: Schema.Void,
  handler: ({ requestId }) => Effect.sync(() => stopWindowsDictation(requestId)),
});
export const dictationText = DesktopIpc.makeIpcMethod({
  channel: "desktop:dictation-text",
  payload: Request,
  result: Schema.String,
  handler: ({ requestId }) => Effect.sync(() => getWindowsDictationText(requestId)),
});
export const dictationLevel = DesktopIpc.makeIpcMethod({
  channel: "desktop:dictation-level",
  payload: Request,
  result: Schema.Number,
  handler: ({ requestId }) => Effect.sync(() => getWindowsDictationLevel(requestId)),
});
