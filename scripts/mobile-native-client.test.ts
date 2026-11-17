import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { NativeClientError, resolveExpoAndroidDevice } from "./mobile-native-client.ts";

it.layer(NodeServices.layer)("Expo Android target mapping", (it) => {
  it.effect("maps the selected adb serial to Expo's exact AVD name", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const name = yield* resolveExpoAndroidDevice("emulator-5554", (program, args) => {
        calls.push([program, ...args]);
        return Effect.succeed("J1_Compact_QA_HostFixed_20261115\r\nOK\r\n");
      });
      assert.strictEqual(name, "J1_Compact_QA_HostFixed_20261115");
      assert.deepStrictEqual(calls, [["adb", "-s", "emulator-5554", "emu", "avd", "name"]]);
    }),
  );

  for (const output of [
    "",
    "OK",
    "\nOK",
    "AVD",
    "KO: unknown emulator",
    "AVD\nKO",
    "AVD\nother\nOK",
  ]) {
    it.effect(`rejects missing or malformed target response ${JSON.stringify(output)}`, () =>
      Effect.gen(function* () {
        const error = yield* resolveExpoAndroidDevice("emulator-5554", () =>
          Effect.succeed(output),
        ).pipe(Effect.flip);
        assert.instanceOf(error, NativeClientError);
        assert.include(error.message, "Could not resolve the Expo AVD name");
      }),
    );
  }

  it.effect("preserves adb rejection rather than selecting another emulator", () =>
    Effect.gen(function* () {
      const failure = new NativeClientError({ message: "device not found" });
      const error = yield* resolveExpoAndroidDevice("emulator-5554", () =>
        Effect.fail(failure),
      ).pipe(Effect.flip);
      assert.strictEqual(error, failure);
    }),
  );
});
