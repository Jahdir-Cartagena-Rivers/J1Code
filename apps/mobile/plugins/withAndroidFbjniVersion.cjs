const fs = require("node:fs");
const path = require("node:path");
const { withProjectBuildGradle } = require("expo/config-plugins");

// Shiki requests fbjni:+. Match React Native's JNI dependency instead of
// letting that wildcard select a library built against a newer C++ runtime.
module.exports = function withAndroidFbjniVersion(config) {
  return withProjectBuildGradle(config, (next) => {
    if (next.modResults.language !== "groovy")
      throw new Error("The fbjni compatibility plugin requires a Groovy project build.gradle.");
    const root = path.dirname(require.resolve("react-native/package.json", { paths: [next.modRequest.projectRoot] }));
    const catalog = fs.readFileSync(path.join(root, "gradle/libs.versions.toml"), "utf8");
    const version = /^fbjni\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?)"\s*$/m.exec(catalog)?.[1];
    if (!version) throw new Error("Could not read React Native's fbjni version from its Gradle catalog.");
    const begin = "// @generated begin j1-fbjni-version";
    const end = "// @generated end j1-fbjni-version";
    const previous = /\/\/ @generated begin j1-fbjni-version[\s\S]*?\/\/ @generated end j1-fbjni-version/g;
    const contents = next.modResults.contents;
    if ((contents.includes(begin) || contents.includes(end)) && (contents.match(previous)?.length !== 1))
      throw new Error("The generated fbjni compatibility block is incomplete or duplicated.");
    next.modResults.contents = contents.replace(previous, "").trimEnd() + `\n\n${begin}
allprojects {
  configurations.configureEach {
    resolutionStrategy.force 'com.facebook.fbjni:fbjni:${version}'
  }
}
${end}\n`;
    return next;
  });
};
