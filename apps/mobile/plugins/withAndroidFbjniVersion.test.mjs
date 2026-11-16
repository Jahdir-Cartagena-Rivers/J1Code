import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOs from "node:os";
import { expect, it } from "vite-plus/test";
import withAndroidFbjniVersion from "./withAndroidFbjniVersion.cjs";

async function fixture(run) {
  const projectRoot = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "j1-fbjni-"));
  const root = NodePath.join(projectRoot, "node_modules/react-native");
  await NodeFs.mkdir(NodePath.join(root, "gradle"), { recursive: true });
  await NodeFs.writeFile(NodePath.join(root, "package.json"), '{"name":"react-native"}');
  const catalog = NodePath.join(root, "gradle/libs.versions.toml");
  const transform = async (contents, language = "groovy") => {
    const config = withAndroidFbjniVersion({ name: "Test", slug: "test" });
    const result = await config.mods.android.projectBuildGradle({ ...config, modRequest: { platform: "android", modName: "projectBuildGradle", projectRoot, introspect: false }, modResults: { language, contents } });
    return result.modResults.contents;
  };
  try { await run({ catalog, transform }); }
  finally { await NodeFs.rm(projectRoot, { recursive: true, force: true }); }
}

it("uses the installed React Native version, stays idempotent, and updates its own block", () => fixture(async ({ catalog, transform }) => {
  const original = "buildscript { /* project configuration */ }\n";
  await NodeFs.writeFile(catalog, '[versions]\nfbjni = "0.7.0"\n');
  const generated = await transform(original);
  expect(generated).toContain("resolutionStrategy.force 'com.facebook.fbjni:fbjni:0.7.0'");
  expect(generated.startsWith(original)).toBe(true);
  expect(await transform(generated)).toBe(generated);
  await NodeFs.writeFile(catalog, '[versions]\nfbjni = "0.8.0"\n');
  const updated = await transform(generated);
  expect(updated).toContain("fbjni:0.8.0");
  expect(updated).not.toContain("fbjni:0.7.0");
}));

it("rejects unsupported catalog, Gradle language and broken generated blocks", () => fixture(async ({ catalog, transform }) => {
  await NodeFs.writeFile(catalog, '[versions]\n');
  await expect(transform("")).rejects.toThrow("Could not read React Native");
  await NodeFs.writeFile(catalog, '[versions]\nfbjni = "0.7.0"\n');
  await expect(transform("", "kotlin")).rejects.toThrow("requires a Groovy");
  await expect(transform("// @generated begin j1-fbjni-version")).rejects.toThrow("incomplete or duplicated");
}));
