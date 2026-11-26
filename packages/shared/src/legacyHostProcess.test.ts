import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "./HostProcess.ts";
import * as Legacy from "./legacyHostProcess.ts";

describe("legacy host process injection", () => {
  it.effect("shares a J1 platform override with the upstream Windows branch", () =>
    Effect.gen(function* () {
      const [platform, upstreamWindows, legacyWindows] = yield* Effect.all([
        HostProcess.Platform,
        HostProcess.isWindows,
        Legacy.isHostWindows,
      ]).pipe(Effect.provideService(Legacy.HostProcessPlatform, "win32"));
      assert.equal(platform, "win32");
      assert.isTrue(upstreamWindows);
      assert.isTrue(legacyWindows);
    }),
  );

  it.effect("shares upstream environment injection with existing J1 consumers", () =>
    Effect.gen(function* () {
      const fixture = { J1_TEST_ENVIRONMENT: "isolated" };
      const environment = yield* Legacy.HostProcessEnvironment.pipe(
        Effect.provideService(HostProcess.Environment, fixture),
      );
      assert.deepEqual(environment, fixture);
    }),
  );
});
