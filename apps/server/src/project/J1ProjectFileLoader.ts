import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { J1_PROJECT_FILE_NAME, type J1ProjectFile } from "@j1code/contracts";
import { J1ProjectFileFromJson } from "@j1code/shared/j1ProjectFile";

const decodeJ1ProjectFileJson = Schema.decodeEffect(J1ProjectFileFromJson);

export class J1ProjectFileLoadError extends Schema.TaggedError<J1ProjectFileLoadError>()(
  "J1ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${J1_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class J1ProjectFileLoader extends Context.Service<
  J1ProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<J1ProjectFile>>;
  }
>()("@j1code/server/project/J1ProjectFileLoader") {}

const logJ1ProjectFileLoadError = (error: J1ProjectFileLoadError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: J1ProjectFileLoader["Service"]["load"] = Effect.fn("J1ProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, J1_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logJ1ProjectFileLoadError(
                  new J1ProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<J1ProjectFile>();
      }
      return yield* decodeJ1ProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logJ1ProjectFileLoadError(
              new J1ProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<J1ProjectFile>())),
        }),
      );
    },
  );

  return J1ProjectFileLoader.of({ load });
});

export const layer = Layer.effect(J1ProjectFileLoader, make);
