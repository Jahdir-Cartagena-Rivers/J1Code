import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Settings from "../../settings/DesktopAppSettings.ts";
import { getCloseBehavior, setCloseBehavior } from "./closeBehavior.ts";

describe("close preference IPC", () => {
  it.effect(
    "changes the preference immediately without relaunching or touching other settings",
    () =>
      Effect.gen(function* () {
        const settings = yield* Settings.DesktopAppSettings;
        const initial = yield* settings.get;
        yield* setCloseBehavior.handler("tray");
        assert.equal(yield* getCloseBehavior.handler(), "tray");
        assert.deepEqual(yield* settings.get, { ...initial, closeBehavior: "tray" });
        yield* setCloseBehavior.handler("ask");
        assert.deepEqual(yield* settings.get, initial);
      }).pipe(Effect.provide(Settings.layerTest(Settings.DEFAULT_DESKTOP_SETTINGS))),
  );

  it.effect("rejects malformed choices without changing the remembered preference", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.DesktopAppSettings;
      const initial = yield* settings.get;
      for (const invalid of [null, true, "exit-and-delete", { closeBehavior: "quit" }]) {
        const result = yield* Effect.result(setCloseBehavior.handler(invalid));
        assert.equal(result._tag, "Failure");
        assert.deepEqual(yield* settings.get, initial);
      }
    }).pipe(Effect.provide(Settings.layerTest(Settings.DEFAULT_DESKTOP_SETTINGS))),
  );
});
