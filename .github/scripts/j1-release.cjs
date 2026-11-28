const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

function releaseIdentity(baseVersion, runNumber) {
  const base = releaseVersion(baseVersion);
  const run = Number(runNumber);
  if (
    !base ||
    base[2] !== 0 ||
    !/^[1-9]\d*$/.test(String(runNumber)) ||
    !Number.isSafeInteger(run)
  ) {
    throw new Error("Expected a J1 base version and a positive GitHub run number.");
  }
  const revision = base[1] + run;
  if (!Number.isSafeInteger(revision) || revision > 65535 || base[0] > 65535) {
    throw new Error("J1 release revision exceeds the Windows version range.");
  }
  const version = `${base[0]}.${revision}.0`;
  return { version, tag: releaseTag(version) };
}

// Map the historical upstream-based version into J1's independent sequence.
function releaseVersion(version) {
  const legacy = /^\d+\.\d+\.\d+-j1\.(0|[1-9]\d*)$/.exec(version);
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const parts = legacy ? [1, Number(legacy[1]), 0] : stable?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : undefined;
}

function releaseTag(version) {
  if (!releaseVersion(version)) throw new Error("Invalid J1 release version.");
  return version.includes("-j1.") ? `j1-code-${version}` : `v${version}`;
}

function releaseTitle(version) {
  const parts = releaseVersion(version);
  if (!parts) throw new Error("Invalid J1 release version.");
  return `J1 Code v${parts[0]}.${parts[1]}${parts[2] ? `.${parts[2]}` : ""}`;
}

function previousReleaseTag(releases, version) {
  const current = releaseVersion(version);
  if (!current) throw new Error("Invalid J1 release version.");
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({
      tag: release.tag_name,
      version: releaseVersion(release.tag_name.replace(/^(?:j1-code-|v)/, "")),
    }))
    .filter((release) => release.version && compare(release.version, current) < 0)
    .sort((a, b) => compare(b.version, a.version))[0]?.tag;
}

function validatePublicText(text) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 500 ||
    /[\r\n\x00-\x1f<>`#\[\]]/u.test(text) ||
    /(?:[a-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|private|mnt|var|etc|root|Volumes)\/|~[\\/])/iu.test(
      text,
    ) ||
    /(?:-----BEGIN .*PRIVATE KEY|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[a-z0-9_-]{12,}|\b(?:api[_ -]?key|password|token|secret)\s*[:=]\s*\S+)/iu.test(
      text,
    ) ||
    /\b(?:QA|CI|worktrees?|checkpoints?|fixtures?|typechecks?|tests?|testing|internal verification|verification report|acceptance checks?|runtime checks?|source checks?|Engineering Room|Head Admin)\b/iu.test(
      text,
    ) ||
    /@[a-z0-9_-]+/iu.test(text)
  ) {
    throw new Error(
      "Release highlights must be public-facing changes without private paths, secrets or internal verification details.",
    );
  }
  return text.trim();
}

function validateSectionTitle(title) {
  const value = validatePublicText(title);
  if (value.length > 48 || !/^\p{L}[\p{L}\p{N} &-]*$/u.test(value))
    throw new Error("Expected a short public release section title.");
  return value;
}

function readReleaseHighlights(file = path.join(__dirname, "../release-highlights.json")) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !value ||
    Object.keys(value).some((key) => !["since", "highlights", "sections"].includes(key)) ||
    !(
      value.since === null ||
      (typeof value.since === "string" &&
        /^(?:v\d+\.\d+\.\d+|j1-code-\d+\.\d+\.\d+-j1\.\d+)$/u.test(value.since))
    ) ||
    !Array.isArray(value.highlights) ||
    (value.sections !== undefined && !Array.isArray(value.sections))
  ) {
    throw new Error(
      "Expected curated highlights and their previous published release tag (since).",
    );
  }
  const sections = value.sections?.map((section) => {
    if (
      !section ||
      Object.keys(section).some((key) => !["title", "highlights"].includes(key)) ||
      !Array.isArray(section.highlights) ||
      section.highlights.length === 0
    )
      throw new Error("Expected a public section title and at least one change.");
    return {
      title: validateSectionTitle(section.title),
      highlights: section.highlights.map(validatePublicText),
    };
  });
  const count =
    value.highlights.length + (sections?.reduce((n, part) => n + part.highlights.length, 0) ?? 0);
  if (count < 1 || count > 20) throw new Error("Expected curated public release highlights.");
  return {
    since: value.since,
    highlights: value.highlights.map(validatePublicText),
    ...(sections === undefined ? {} : { sections }),
  };
}

function validateReleaseNotes(body, repository, version) {
  if (typeof body !== "string" || body.length > 20000)
    throw new Error("Invalid public release notes.");
  const lines = body.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.shift() !== "## What's Changed") throw new Error("Expected public release highlights.");
  const changelog = lines.pop();
  const target = `https://github.com/${repository}/`;
  const tag = releaseTag(version);
  if (
    !(
      changelog === `**Full Changelog**: ${target}commits/${tag}` ||
      (changelog?.startsWith(`**Full Changelog**: ${target}compare/`) &&
        /^(?:v\d+\.\d+\.\d+|j1-code-\d+\.\d+\.\d+-j1\.\d+)$/u.test(
          changelog.slice(`**Full Changelog**: ${target}compare/`.length, -`...${tag}`.length),
        ) &&
        changelog.endsWith(`...${tag}`))
    )
  )
    throw new Error("Expected the full repository changelog link.");
  if (lines.at(-1)?.startsWith("**Contributors**: ")) {
    const contributors = lines.pop().slice("**Contributors**: ".length).split(", ");
    if (
      !contributors.every((entry) =>
        /^@[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/iu.test(entry),
      )
    )
      throw new Error("Invalid release attribution.");
  }
  let count = 0;
  let needsBullet = false;
  const sections = new Set();
  for (const line of lines) {
    if (line.startsWith("### ")) {
      const title = validateSectionTitle(line.slice(4));
      if (needsBullet || sections.has(title))
        throw new Error("Release sections must be distinct and contain changes.");
      needsBullet = true;
      sections.add(title);
    } else {
      if (!line.startsWith("* "))
        throw new Error("Only public change bullets and attribution belong in release notes.");
      validatePublicText(line.slice(2));
      count++;
      needsBullet = false;
    }
  }
  if (count < 1 || count > 20 || needsBullet)
    throw new Error("Expected curated public release highlights.");
  return body;
}

function releaseNotes(repository, version, sha, runGh = gh, curated = readReleaseHighlights()) {
  const pages = JSON.parse(
    runGh(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"]),
  );
  let previousTag = previousReleaseTag(pages.flat(), version);
  if (curated.since !== (previousTag ?? null))
    throw new Error(
      "Curated highlights belong to a different previous release; refresh them before publishing.",
    );
  const highlights = curated.highlights.map(validatePublicText);
  const single = () => [
    { commits: [JSON.parse(runGh(["api", `repos/${repository}/commits/${sha}`]))] },
  ];
  let commits;
  if (previousTag) {
    try {
      commits = JSON.parse(
        runGh([
          "api",
          `repos/${repository}/compare/${previousTag}...${sha}?per_page=100`,
          "--paginate",
          "--slurp",
        ]),
      );
    } catch (error) {
      // A rewritten history leaves older tags with no shared ancestor; describe this build alone.
      if (!/No common ancestor/u.test(`${error.stderr ?? ""}${error.stdout ?? ""}${error.message}`))
        throw error;
      previousTag = undefined;
    }
  }
  commits ??= single();
  if (previousTag && commits.some((page) => !["ahead", "identical"].includes(page.status))) {
    throw new Error("The previous release is not an ancestor of this build.");
  }
  // Commit subjects are unreviewed internal text; only retain public GitHub attribution.
  const contributors = [
    ...new Set(
      commits
        .flatMap((page) => page.commits)
        .map((entry) => entry.author?.login)
        .filter(Boolean),
    ),
  ];
  if (
    !contributors.every((login) =>
      /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/iu.test(login),
    )
  )
    throw new Error("Invalid release attribution.");
  const changelog = previousTag
    ? `https://github.com/${repository}/compare/${previousTag}...${releaseTag(version)}`
    : `https://github.com/${repository}/commits/${releaseTag(version)}`;
  const bullets = (items) => items.map((text) => `* ${validatePublicText(text)}`).join("\n");
  const changes = [
    bullets(highlights),
    ...(curated.sections ?? []).map(
      (section) => `### ${validateSectionTitle(section.title)}\n\n${bullets(section.highlights)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  const body = `## What's Changed\n\n${changes}\n\n${contributors.length ? `**Contributors**: ${contributors.map((login) => `@${login}`).join(", ")}\n\n` : ""}**Full Changelog**: ${changelog}\n`;
  return validateReleaseNotes(body, repository, version);
}

function artifactNames(version) {
  releaseTag(version);
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
  if (
    (tagSha != null && tagSha !== sha) ||
    (release && release.target_commitish !== sha) ||
    (release && !release.draft && tagSha !== sha)
  ) {
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

function publishRelease(directory, version, env = process.env, runGh = gh, curated) {
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  const runId = env.J1_RELEASE_BUILD_RUN_ID ?? env.GITHUB_RUN_ID;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid GitHub repository.");
  if (env.J1_RELEASE_BUILD_RUN_ID !== undefined && !/^[1-9]\d*$/.test(runId)) {
    throw new Error("Invalid staged build run ID.");
  }
  const tag = releaseTag(version);
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
    `${JSON.stringify({ version, commit: sha, repository, runId }, null, 2)}\n`,
  );
  const api = (endpoint) => JSON.parse(runGh(["api", `repos/${repository}/${endpoint}`]));
  const headSha = api("git/ref/heads/j1-code").object.sha;
  // REST's tag endpoint cannot find drafts with a pending tag; the CLI can.
  const readRelease = () => {
    try {
      const result = JSON.parse(
        runGh([
          "release",
          "view",
          tag,
          "--repo",
          repository,
          "--json",
          "targetCommitish,isDraft,isPrerelease,assets,url,body",
        ]),
      );
      return {
        target_commitish: result.targetCommitish,
        draft: result.isDraft,
        prerelease: result.isPrerelease,
        assets: result.assets,
        html_url: result.url,
        body: result.body,
      };
    } catch (error) {
      if (String(error.stderr).trim() !== "release not found") throw error;
      return null;
    }
  };
  const readTag = () => {
    try {
      return api(`git/ref/tags/${tag}`).object.sha;
    } catch (error) {
      if (!String(error.stderr).includes("HTTP 404")) throw error;
      return null;
    }
  };
  const release = readRelease();
  const tagSha = readTag();
  const state = assertPublishable({ headSha, sha, release, tagSha, requiredNames: names });
  if (state === "already-published") {
    validateReleaseNotes(release.body, repository, version);
    return release.html_url;
  }
  const notesPath = path.join(directory, "release-notes.md");
  fs.writeFileSync(notesPath, releaseNotes(repository, version, sha, runGh, curated));
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
      releaseTitle(version),
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
  const uploaded = readRelease();
  if (
    !uploaded ||
    names.some(
      (name) =>
        !uploaded.assets?.some(
          (asset) =>
            asset.name === name && asset.size === fs.statSync(path.join(directory, name)).size,
        ),
    )
  ) {
    throw new Error("Draft release upload is incomplete; leaving it hidden from the updater.");
  }
  // Recheck after upload as well; a new push may have superseded a long build.
  assertPublishable({
    headSha: api("git/ref/heads/j1-code").object.sha,
    sha,
    release: uploaded,
    tagSha: readTag(),
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
    "--title",
    releaseTitle(version),
    "--notes-file",
    notesPath,
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
  } else if (command === "validate-highlights") {
    readReleaseHighlights(value);
    console.log("Public release highlights validated.");
  } else if (command === "publish") {
    console.log(publishRelease(value ?? "release", process.env.J1_RELEASE_VERSION));
  } else throw new Error("Expected version, validate-highlights or publish command.");
}

module.exports = {
  releaseIdentity,
  releaseVersion,
  releaseTag,
  releaseTitle,
  previousReleaseTag,
  releaseNotes,
  validatePublicText,
  readReleaseHighlights,
  validateReleaseNotes,
  artifactNames,
  validateArtifacts,
  assertPublishable,
  publishRelease,
};
