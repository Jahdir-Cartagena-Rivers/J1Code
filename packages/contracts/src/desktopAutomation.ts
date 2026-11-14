import * as Schema from "effect/Schema";

export const DesktopReadCommand = Schema.Literals([
  "status",
  "version",
  "skills",
  "snapshot",
  "find",
  "get",
  "is",
  "list-apps",
  "list-windows",
  "list-displays",
  "list-surfaces",
  "clipboard-get",
  "wait",
]);
export const DesktopActionCommand = Schema.Literals([
  "permissions",
  "click",
  "double-click",
  "triple-click",
  "right-click",
  "type",
  "set-value",
  "clear",
  "focus",
  "select",
  "toggle",
  "check",
  "uncheck",
  "expand",
  "collapse",
  "scroll",
  "scroll-to",
  "press",
  "hover",
  "drag",
  "mouse-move",
  "mouse-click",
  "mouse-wheel",
  "launch",
  "close-app",
  "focus-window",
  "resize-window",
  "move-window",
  "minimize",
  "maximize",
  "restore",
  "open-system-surface",
  "clipboard-set",
  "clipboard-clear",
]);
const Arguments = Schema.Array(Schema.String.check(Schema.isMaxLength(32_768))).check(
  Schema.isMaxLength(64),
);
export const DesktopReadInput = Schema.Struct({
  command: DesktopReadCommand,
  args: Schema.optional(Arguments),
});
export const DesktopActionInput = Schema.Struct({
  command: DesktopActionCommand,
  args: Schema.optional(Arguments),
  headed: Schema.optional(Schema.Boolean),
  stdin: Schema.optional(Schema.String.check(Schema.isMaxLength(100_000))),
});
export const DesktopScreenshotInput = Schema.Struct({
  app: Schema.optional(Schema.String),
  windowId: Schema.optional(Schema.String),
  screen: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const DesktopCommandResult = Schema.Struct({ result: Schema.Unknown });
export const DesktopScreenshotResult = Schema.Struct({
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  }),
});
const encodeErrorDetail = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export class DesktopToolError extends Schema.TaggedError<DesktopToolError>()("DesktopToolError", {
  reason: Schema.String,
  detail: Schema.optional(Schema.Unknown),
  actionMayHaveRun: Schema.Boolean,
}) {
  override get message(): string {
    return encodeErrorDetail({
      reason: this.reason,
      detail: this.detail,
      actionMayHaveRun: this.actionMayHaveRun,
    });
  }
}
