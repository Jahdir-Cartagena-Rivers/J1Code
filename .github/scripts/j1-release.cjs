const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

function releaseIdentity(baseVersion, runNumber) {
  const match = /^(\d+\.\d+\.\d+)-j1\.(0|[1-9]\d*)$/.exec(baseVersion);
  const run = Number(runNumber);
  if (!match || !/^[1-9]\d*$/.test(String(runNumber)) || !Number.isSafeInteger(run)) {
    throw new Error("Expected a J1 base version and a positive GitHub run number.");
  }
  const revision = Number(match[2]) + run;
  if (!Number.isSafeInteger(revision) || revision > 65535) {
    throw new Error("J1 release revision exceeds the Windows version range.");
  }
  const version = `${match[1]}-j1.${revision}`;
  return { version, tag: `j1-code-${version}` };
}

function artifactNames(version) {
  if (!/^\d+\.\d+\.\d+-j1\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Invalid J1 release version.");
  }
  const installer = `J1-Code-${version}-windows-x64-setup.exe`;
  return [installer, `${installer}.blockmap`, "latest.yml", `t3-${version}-linux-x64.tar.gz`];
}

function validateArtifacts(directory, version) {
  const names = artifactNames(version);
  for (const name of names) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.size === 0)
      throw new Error(`Missing or empty release file: ${name}`);
  }
  // Use the already installed server YAML dependency; no extra release dependency.
  const requireServer = createRequire(path.resolve(__dirname, "../../apps/server/package.json"));
  const manifest = requireServer("yaml").parse(
    fs.readFileSync(path.join(directory, "latest.yml"), "utf8"),
  );
  const installer = fs.readFileSync(path.join(directory, names[0]));
  const sha512 = crypto.createHash("sha512").update(installer).digest("base64");
  if (
    manifest?.version !== version ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 1 ||
    manifest.files[0]?.url !== names[0] ||
    manifest.files[0]?.sha512 !== sha512 ||
    manifest.files[0]?.size !== installer.length ||
    manifest.path !== names[0] ||
    manifest.sha512 !== sha512
  )
    throw new Error("The update manifest does not match the built installer/version/checksum.");
  return names;
}

function assertPublishable({ headSha, sha, release, tagSha, requiredNames }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || headSha !== sha) {
    throw new Error("This build is no longer the head of j1-code; keep the current release.");
  }
  if (release && (release.target_commitish !== sha || tagSha !== sha)) {
    throw new Error("The release tag already belongs to a different commit.");
  }
  if (release && !release.draft) {
    if (
      release.prerelease ||
      requiredNames.some((name) => !release.assets?.some((asset) => asset.name === name))
    ) {
      throw new Error("Existing published release is incomplete or on the wrong channel.");
    }
    return "already-published";
  }
  return "publish-draft";
}

function publishRelease(directory, version, env = process.env, runGh = gh) {
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid GitHub repository.");
  const tag = `j1-code-${version}`;
  const names = validateArtifacts(directory, version);
  const checksumName = `SHA256SUMS-${version}.txt`;
  const provenanceName = "j1-build.json";
  names.push(checksumName, provenanceName);
  const checksums = names.slice(0, -2).map(
    (name) =>
      `${crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(directory, name)))
        .digest("hex")}  ${name}`,
  );
  fs.writeFileSync(path.join(directory, checksumName), `${checksums.join("\n")}\n`);
  fs.writeFileSync(
    path.join(directory, provenanceName),
    `${JSON.stringify({ version, commit: sha, repository, runId: env.GITHUB_RUN_ID }, null, 2)}\n`,
  );
  const api = (endpoint) => JSON.parse(runGh(["api", `repos/${repository}/${endpoint}`]));
  const headSha = api("git/ref/heads/j1-code").object.sha;
  let release = null;
  try {
    release = api(`releases/tags/${tag}`);
  } catch (error) {
    if (!String(error.stderr).includes("HTTP 404")) throw error;
  }
  const tagSha = release ? api(`git/ref/tags/${tag}`).object.sha : null;
  const state = assertPublishable({ headSha, sha, release, tagSha, requiredNames: names });
  if (state === "already-published") return release.html_url;
  const notesPath = path.join(directory, "release-notes.md");
  fs.writeFileSync(
    notesPath,
    `J1 Code ${version} — Windows x64 installer\n\nBuilt automatically from ${sha}. Includes the matching Linux runtime for WSL.\n\nThis unsigned NSIS installer uses the private ${repository} update feed. Sign in with GitHub CLI for private updates. Your profiles and provider authentication remain local.\n\nVerify downloads using ${checksumName}. Publishing updates does not automatically restart or install the app.\n`,
  );
  if (!release)
    runGh([
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--target",
      sha,
      "--draft",
      "--title",
      `J1 Code ${version}`,
      "--notes-file",
      notesPath,
    ]);
  runGh([
    "release",
    "upload",
    tag,
    "--repo",
    repository,
    "--clobber",
    ...names.map((name) => path.join(directory, name)),
  ]);
  const uploaded = api(`releases/tags/${tag}`);
  if (
    names.some((name) => !uploaded.assets?.some((asset) => asset.name === name && asset.size > 0))
  ) {
    throw new Error("Draft release upload is incomplete; leaving it hidden from the updater.");
  }
  // Recheck after upload as well; a new push may have superseded a long build.
  assertPublishable({
    headSha: api("git/ref/heads/j1-code").object.sha,
    sha,
    release: uploaded,
    tagSha: api(`git/ref/tags/${tag}`).object.sha,
    requiredNames: names,
  });
  runGh([
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    "--prerelease=false",
    "--latest",
  ]);
  return uploaded.html_url;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (require.main === module) {
  const [command, value] = process.argv.slice(2);
  if (command === "version") {
    const base = JSON.parse(fs.readFileSync("apps/desktop/package.json", "utf8")).version;
    const identity = releaseIdentity(base, process.env.GITHUB_RUN_NUMBER);
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${identity.version}\ntag=${identity.tag}\n`,
      );
    console.log(JSON.stringify(identity));
  } else if (command === "publish") {
    console.log(publishRelease(value ?? "release", process.env.J1_RELEASE_VERSION));
  } else throw new Error("Expected version or publish command.");
}

module.exports = {
  releaseIdentity,
  artifactNames,
  validateArtifacts,
  assertPublishable,
  publishRelease,
};
