import { it, expect } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@j1code/shared/hostProcess";
import {
  extractNativeArchive,
  verifyNativeHash,
  validatePackagedLightpanda,
} from "./stage-lightpanda.ts";
it("rejects damaged artifact bytes", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  expect(() => verifyNativeHash(bytes, hash)).not.toThrow();
  expect(() => verifyNativeHash(new Uint8Array([1, 2, 4]), hash)).toThrow("integrity");
});
it("rejects missing packaged browser and notices", async () => {
  await expect(validatePackagedLightpanda("missing-browser-fixture")).rejects.toThrow();
});
it.effect("extracts root and nested license notices with the native Windows extractor", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) !== "win32") return;
    yield* Effect.tryPromise(async () => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "j1-native-archive-test-"),
      );
      if (!directory.startsWith(NodePath.resolve(NodeOS.tmpdir()) + NodePath.sep))
        throw new Error("Unexpected fixture directory");
      try {
        const archive = NodePath.join(directory, "fixture.zip");
        const output = NodePath.join(directory, "output");
        await NodeFSP.mkdir(output);
        // A two-entry ZIP containing LICENSE and a nested dependency notice.
        await NodeFSP.writeFile(
          archive,
          Buffer.from(
            "UEsDBBQAAAAAAPmZbl3tPJelFgAAABYAAAAHAAAATElDRU5TRUZpeHR1cmUgbGljZW5zZSBub3RpY2VQSwMEFAAAAAAA+ZluXVwdYjcZAAAAGQAAABUAAABsaWNlbnNlcy9ydXN0L01JVC50eHRGaXh0dXJlIGRlcGVuZGVuY3kgbm90aWNlUEsBAhQAFAAAAAAA+ZluXe08l6UWAAAAFgAAAAcAAAAAAAAAAAAAAIABAAAAAExJQ0VOU0VQSwECFAAUAAAAAAD5mW5dXB1iNxkAAAAZAAAAFQAAAAAAAAAAAAAAgAE7AAAAbGljZW5zZXMvcnVzdC9NSVQudHh0UEsFBgAAAAACAAIAeAAAAIcAAAAAAA==",
            "base64",
          ),
        );
        await extractNativeArchive(archive, output);
        expect(await NodeFSP.readFile(NodePath.join(output, "LICENSE"), "utf8")).toBe(
          "Fixture license notice",
        );
        expect(await NodeFSP.readFile(NodePath.join(output, "licenses/rust/MIT.txt"), "utf8")).toBe(
          "Fixture dependency notice",
        );
        await expect(
          extractNativeArchive(NodePath.join(directory, "missing.zip"), output),
        ).rejects.toThrow();
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    });
  }),
);
