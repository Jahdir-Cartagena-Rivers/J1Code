// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test double supplies Electron's synchronous shortcut driver.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { mausbotSavedAppLaunchId } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { manageMausbotShortcuts } from "./MausbotShortcuts.ts";

it.effect("installs, lists and removes only J1-owned shortcuts without persisting a view key", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "j1-shortcuts-test-" });
    const programs = path.join(root, "Programs");
    const desktop = path.join(root, "Desktop");
    yield* fs.makeDirectory(programs);
    yield* fs.makeDirectory(desktop);
    const executable = "C:\\J1\\J1 Code.exe";
    const appId = "la_1234567890123456";
    const another = path.join(desktop, "Neighbor (J1 Code).lnk");
    const external = JSON.stringify({ target: "C:\\Another.exe", args: "--open" });
    yield* fs.writeFileString(another, external);
    const manage = (request: Parameters<typeof manageMausbotShortcuts>[0]) =>
      Effect.promise(() =>
        manageMausbotShortcuts(
          request,
          { programs, desktop, executable },
          {
            read: (filename) =>
              JSON.parse(NodeFS.readFileSync(filename, "utf8")) as { target: string; args: string },
            write: (filename, target, args) => {
              NodeFS.writeFileSync(filename, JSON.stringify({ target, args }));
              return true;
            },
          },
        ),
      );

    const install = yield* manage({ operation: "install", appId, name: "Ledger" });
    assert.propertyVal(install, "ok", true);
    const icon = path.join(desktop, "Ledger (J1 Code).lnk");
    yield* fs.writeFileString(icon, external);
    assert.deepEqual(yield* manage({ operation: "addToDesktop", appId }), {
      ok: false,
      reason: "taken",
    });
    assert.strictEqual(yield* fs.readFileString(icon), external);
    yield* fs.remove(icon);
    const add = yield* manage({ operation: "addToDesktop", appId });
    assert.propertyVal(add, "ok", true);
    const shortcut = JSON.parse(yield* fs.readFileString(icon)) as { target: string; args: string };
    assert.strictEqual(shortcut.target, executable);
    assert.strictEqual(mausbotSavedAppLaunchId(shortcut.args), appId);
    assert.isNull(mausbotSavedAppLaunchId(`${shortcut.args}&viewKey=secret`));
    const list = yield* manage({ operation: "list" });
    assert.deepInclude(list, {
      available: true,
      apps: [
        {
          id: appId,
          name: "Ledger",
          path: path.join(programs, "J1 Code Apps", "Ledger (J1 Code).lnk"),
          desktop: true,
        },
      ],
    });
    assert.deepEqual(yield* manage({ operation: "uninstall", appId }), { ok: true, removed: true });
    assert.isFalse(yield* fs.exists(icon));
    assert.strictEqual(yield* fs.readFileString(another), external);
  }).pipe(Effect.provide(NodeServices.layer)),
);
