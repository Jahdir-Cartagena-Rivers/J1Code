const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  releaseIdentity,
  releaseTag,
  releaseTitle,
  previousReleaseTag,
  releaseNotes,
  artifactNames,
  validateArtifacts,
  assertPublishable,
  publishRelease: publish,
  readReleaseHighlights,
  validateReleaseNotes,
  validatePublicText,
} = require("./j1-release.cjs");

const version = "1.11.0";
const sha = "a".repeat(40);
const repository = "example/J1Code";
const highlights = ["Updates remain available after reconnecting."];
const initial = { since: null, highlights };
const publishRelease = (...args) => publish(...args, initial);

function releaseView(release) {
  if (!release) {
    const error = new Error("not found");
    error.stderr = "release not found";
    throw error;
  }
  return JSON.stringify({
    targetCommitish: release.target_commitish,
    isDraft: release.draft,
    isPrerelease: release.prerelease,
    assets: release.assets,
    url: release.html_url,
    body: release.body,
  });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "j1-release-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("j1-release-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const names = artifactNames(version);
  const binary = Buffer.from("MZ synthetic installer");
  fs.writeFileSync(path.join(directory, names[0]), binary);
  fs.writeFileSync(path.join(directory, names[1]), "synthetic blockmap");
  fs.writeFileSync(path.join(directory, names[3]), "synthetic Linux runtime");
  const hash = crypto.createHash("sha512").update(binary).digest("base64");
  fs.writeFileSync(
    path.join(directory, "latest.yml"),
    `version: ${version}\nfiles:\n  - url: ${names[0]}\n    sha512: ${hash}\n    size: ${binary.length}\npath: ${names[0]}\nsha512: ${hash}\n`,
  );
  return { directory, names };
}

test("automatic versions increase beyond the base and are stable on retry", () => {
  assert.equal(releaseIdentity("0.0.44-j1.10", "1").version, version);
  assert.deepEqual(releaseIdentity("1.10.0", "1"), { version, tag: "v1.11.0" });
  assert.equal(releaseIdentity("1.10.0", "13").version, "1.23.0");
  assert.deepEqual(releaseIdentity("0.0.44-j1.10", "1"), releaseIdentity("1.10.0", "1"));
  for (const run of ["", "0", "-1", "1.5", "x", "9007199254740993"]) {
    assert.throws(() => releaseIdentity("0.0.44-j1.10", run));
  }
  assert.throws(() => releaseIdentity("1.10.1", "1"));
  assert.throws(() => releaseIdentity("01.10.0", "1"));
  assert.throws(() => releaseIdentity("0.0.44-j1.65535", "1"));
});

test("titles use only J1 versions while historical tags and filenames remain compatible", () => {
  assert.equal(releaseTitle("0.0.44-j1.22"), "J1 Code v1.22");
  assert.equal(releaseTitle("1.23.0"), "J1 Code v1.23");
  assert.equal(releaseTitle("1.23.1"), "J1 Code v1.23.1");
  assert.equal(releaseTag("0.0.44-j1.22"), "j1-code-0.0.44-j1.22");
  assert.equal(artifactNames("0.0.44-j1.22")[0], "J1-Code-0.0.44-j1.22-windows-x64-setup.exe");
  assert.equal(artifactNames("1.23.0")[0], "J1-Code-1.23.0-windows-x64-setup.exe");
  assert.throws(() => artifactNames("../1.23.0"));
});

test("curated notes retain attribution and migrated comparison links without exposing commit subjects", () => {
  const releases = [
    { tag_name: "v1.24.0", draft: true },
    { tag_name: "v1.23.0" },
    { tag_name: "j1-code-0.0.44-j1.22" },
    { tag_name: "v1.99.0", prerelease: true },
    { tag_name: "unrelated" },
    { tag_name: "j1-code-0.0.44-j1.9" },
  ];
  assert.equal(previousReleaseTag(releases, "1.23.0"), "j1-code-0.0.44-j1.22");
  assert.equal(previousReleaseTag(releases, "1.24.0"), "v1.23.0");
  const curated = { since: "j1-code-0.0.44-j1.22", highlights };
  const fakeGh = (args) =>
    args[1].includes("/releases?")
      ? JSON.stringify([releases])
      : JSON.stringify([
          {
            status: "ahead",
            commits: [
              {
                sha,
                commit: { message: "test: private local worktree verification" },
                author: { login: "maintainer" },
              },
              {
                sha: "b".repeat(40),
                commit: { message: "ci: internal-only" },
                author: { login: "dependabot[bot]" },
              },
            ],
          },
        ]);
  const notes = releaseNotes(repository, "1.23.0", sha, fakeGh, curated);
  assert.match(notes, /\* Updates remain available after reconnecting\./);
  assert.match(notes, /\*\*Contributors\*\*: @maintainer, @dependabot\[bot\]/);
  assert.ok(notes.includes("compare/j1-code-0.0.44-j1.22...v1.23.0"));
  assert.ok(!/private|worktree|internal-only/.test(notes));
  assert.equal(validateReleaseNotes(notes, repository, "1.23.0"), notes);
  assert.throws(() => releaseNotes(repository, "1.23.0", sha, fakeGh, initial), /previous release/);
  assert.throws(
    () =>
      releaseNotes(
        repository,
        "1.23.0",
        sha,
        (args) =>
          args[1].includes("/releases?")
            ? JSON.stringify([releases])
            : JSON.stringify([{ status: "diverged", commits: [] }]),
        curated,
      ),
    /ancestor/,
  );
});

test("no-ancestor fallback and network failures keep their distinct behavior", () => {
  const fakeGh = (args) => {
    if (args[1].includes("/releases?")) return JSON.stringify([[{ tag_name: "v1.22.0" }]]);
    if (args[1].includes("/compare/")) {
      const error = new Error("compare failed");
      error.stderr = "No common ancestor";
      throw error;
    }
    return JSON.stringify({ sha, commit: { message: "private subject" }, author: null });
  };
  const curated = { since: "v1.22.0", highlights };
  const notes = releaseNotes(repository, "1.23.0", sha, fakeGh, curated);
  assert.ok(notes.includes("commits/v1.23.0"));
  assert.ok(!notes.includes("private subject"));
  assert.throws(
    () =>
      releaseNotes(
        repository,
        "1.23.0",
        sha,
        () => {
          throw new Error("network down");
        },
        curated,
      ),
    /network down/,
  );
});

test("rejects private paths, secrets, rosters and internal narrative without echoing them", () => {
  for (const text of [
    "Saved C:\\Users\\Somebody\\private.txt",
    "Saved C:/Users/Somebody/private.txt",
    "/home/somebody/data",
    "file:///etc/private",
    "\\\\host\\share",
    "Passed 38 tests",
    "CI passed",
    "QA report",
    "Engineering Room roster",
    "@TeamLead assigned work",
    "Verification report",
    "token=synthetic-secret",
    "github_pat_" + "x".repeat(30),
    "Changes\n## Verification",
  ]) {
    assert.throws(
      () => validatePublicText(text),
      (error) => !error.message.includes(text),
    );
  }
  assert.equal(
    validatePublicText("Device approvals remain available after reconnecting."),
    "Device approvals remain available after reconnecting.",
  );
});

test("requires explicit nonempty curated input and rejects malformed or extra fields", (t) => {
  const { directory } = fixture(t);
  const file = path.join(directory, "highlights.json");
  for (const value of [
    {},
    { since: null, highlights: [] },
    { ...initial, privateReport: "hidden" },
    { ...initial, since: "../private" },
    { ...initial, highlights: ["CI passed"] },
  ]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readReleaseHighlights(file));
  }
  fs.writeFileSync(file, JSON.stringify(initial));
  assert.deepEqual(readReleaseHighlights(file), initial);
  assert.throws(() => readReleaseHighlights(file + "-missing"));
});

test("release body validation rejects appended manual sections, wrong links and forged attribution", () => {
  const clean = `## What's Changed\n\n* ${highlights[0]}\n\n**Full Changelog**: https://github.com/${repository}/commits/v${version}\n`;
  for (const body of [
    clean + "\n## Verification\nPrivate details",
    clean.replace(highlights[0], "QA passed"),
    clean.replace(repository, "other/repo"),
    clean.replace(
      "**Full Changelog**",
      "**Contributors**: @good [private](file:///tmp/key)\n\n**Full Changelog**",
    ),
  ])
    assert.throws(() => validateReleaseNotes(body, repository, version));
});

test("supports curated groups while retaining the historical changelog format", (t) => {
  const { directory } = fixture(t);
  const file = path.join(directory, "grouped.json");
  const grouped = {
    since: "v1.10.0",
    highlights: [],
    sections: [
      { title: "Android", highlights: ["Open side chats beside the current conversation."] },
      { title: "Permissions", highlights: ["Explain when Claude Auto is unavailable."] },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(grouped));
  assert.deepEqual(readReleaseHighlights(file), grouped);
  const notes = [
    "## What's Changed",
    "### Android",
    "* Open side chats beside the current conversation.",
    "### Permissions",
    "* Explain when Claude Auto is unavailable.",
    `**Full Changelog**: https://github.com/${repository}/compare/v1.10.0...v${version}`,
  ].join("\n\n");
  const fakeGh = (args) =>
    args[1].includes("/releases?")
      ? JSON.stringify([[{ tag_name: "v1.10.0" }]])
      : JSON.stringify([{ status: "ahead", commits: [{ sha }] }]);
  assert.equal(releaseNotes(repository, version, sha, fakeGh, grouped).trim(), notes);
  assert.equal(validateReleaseNotes(notes, repository, version), notes);
  assert.throws(() =>
    validateReleaseNotes(notes.replace("### Permissions", "### Android"), repository, version),
  );
  assert.throws(() =>
    validateReleaseNotes(
      notes.replace("* Explain when Claude Auto is unavailable.", ""),
      repository,
      version,
    ),
  );
});

test("validates the complete Windows and matching Linux update set", (t) => {
  const { directory, names } = fixture(t);
  assert.deepEqual(validateArtifacts(directory, version), names);
});

test("rejects missing runtime and a tampered installer before publication", (t) => {
  const { directory, names } = fixture(t);
  fs.appendFileSync(path.join(directory, names[0]), "tamper");
  assert.throws(() => validateArtifacts(directory, version), /manifest/);
  fs.unlinkSync(path.join(directory, names[3]));
  assert.throws(() => validateArtifacts(directory, version));
});

test("rejects wrong-version and path-traversal manifests", (t) => {
  const { directory } = fixture(t);
  const manifest = path.join(directory, "latest.yml");
  const original = fs.readFileSync(manifest, "utf8");
  fs.writeFileSync(manifest, original.replace(`version: ${version}`, "version: 0.0.44-j1.10"));
  assert.throws(() => validateArtifacts(directory, version), /manifest/);
  fs.writeFileSync(manifest, original.replace("url: J1-Code", "url: ../J1-Code"));
  assert.throws(() => validateArtifacts(directory, version), /manifest/);
});

test("blocks superseded builds and tags owned by a different commit", () => {
  const args = { headSha: sha, sha, release: null, tagSha: null, requiredNames: [] };
  assert.equal(assertPublishable(args), "publish-draft");
  assert.throws(() => assertPublishable({ ...args, headSha: "b".repeat(40) }), /head/);
  assert.throws(
    () =>
      assertPublishable({ ...args, release: { target_commitish: "b".repeat(40) }, tagSha: sha }),
    /different commit/,
  );
  assert.throws(
    () =>
      assertPublishable({ ...args, release: { target_commitish: sha }, tagSha: "b".repeat(40) }),
    /different commit/,
  );
  assert.equal(
    assertPublishable({ ...args, release: { target_commitish: sha, draft: true }, tagSha: null }),
    "publish-draft",
  );
  assert.throws(() => assertPublishable({ ...args, tagSha: "b".repeat(40) }), /different commit/);
});

test("never rewrites an existing complete published release", () => {
  const release = {
    target_commitish: sha,
    draft: false,
    prerelease: false,
    assets: [{ name: "latest.yml" }],
  };
  assert.equal(
    assertPublishable({ headSha: sha, sha, release, tagSha: sha, requiredNames: ["latest.yml"] }),
    "already-published",
  );
  assert.throws(
    () =>
      assertPublishable({
        headSha: sha,
        sha,
        release,
        tagSha: sha,
        requiredNames: ["missing.exe"],
      }),
    /incomplete/,
  );
});

test("publishes a complete pending-tag draft and leaves published retries unchanged", (t) => {
  const { directory } = fixture(t);
  const calls = [];
  let release = null;
  const fakeGh = (args) => {
    calls.push(args);
    if (args[0] === "api") {
      if (args[1].includes("/releases?")) return "[[]]";
      if (args[1].includes("/commits/"))
        return JSON.stringify({ sha, commit: { message: "feat: initial release" } });
      if (args[1].endsWith("git/ref/heads/j1-code")) return JSON.stringify({ object: { sha } });
      if (release && !release.draft) return JSON.stringify({ object: { sha } });
      const error = new Error("pending tag");
      error.stderr = "HTTP 404";
      throw error;
    }
    if (args[1] === "view") return releaseView(release);
    if (args[1] === "create")
      release = {
        target_commitish: sha,
        draft: true,
        assets: [],
        html_url: "https://example.test/release",
        body: fs.readFileSync(args[args.indexOf("--notes-file") + 1], "utf8"),
      };
    if (args[1] === "upload")
      release.assets = args
        .slice(args.indexOf("--clobber") + 1)
        .map((file) => ({ name: path.basename(file), size: fs.statSync(file).size }));
    if (args[1] === "edit") release.draft = false;
    return "";
  };
  assert.equal(
    publishRelease(
      directory,
      version,
      {
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: "8282",
        J1_RELEASE_BUILD_RUN_ID: "7171",
      },
      fakeGh,
    ),
    "https://example.test/release",
  );
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, "j1-build.json"), "utf8"));
  assert.equal(provenance.runId, "7171");
  const mutations = calls
    .filter((args) => args[0] === "release" && args[1] !== "view")
    .map((args) => args[1]);
  assert.deepEqual(mutations, ["create", "upload", "edit"]);
  assert.ok(calls.at(-1).includes("--draft=false"));
  assert.ok(calls.at(-1).includes("J1 Code v1.11"));
  assert.match(fs.readFileSync(path.join(directory, "release-notes.md"), "utf8"), /What's Changed/);
  calls.length = 0;
  assert.equal(
    publishRelease(directory, version, { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha }, fakeGh),
    "https://example.test/release",
  );
  assert.ok(!calls.some((args) => args[0] === "release" && args[1] !== "view"));
  release.body += "\n## Verification\nInternal details";
  calls.length = 0;
  assert.throws(
    () =>
      publishRelease(
        directory,
        version,
        { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha },
        fakeGh,
      ),
    /changelog/,
  );
  assert.ok(!calls.some((args) => args[0] === "release" && args[1] !== "view"));
});

test("partial upload stays a draft and API failures are not treated as missing releases", (t) => {
  const { directory } = fixture(t);
  let created = false;
  const calls = [];
  const fakeGh = (args) => {
    calls.push(args);
    if (args[1] === "view")
      return releaseView(created ? { target_commitish: sha, draft: true, assets: [] } : null);
    if (args[0] !== "api") {
      if (args[1] === "create") created = true;
      return "";
    }
    if (args[1].endsWith("git/ref/heads/j1-code")) return JSON.stringify({ object: { sha } });
    if (args[1].includes("/releases?")) return "[[]]";
    if (args[1].includes("/commits/"))
      return JSON.stringify({ sha, commit: { message: "feat: initial release" } });
    const error = new Error("not found");
    error.stderr = "HTTP 404";
    throw error;
  };
  assert.throws(
    () =>
      publishRelease(
        directory,
        version,
        { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha },
        fakeGh,
      ),
    /incomplete/,
  );
  assert.ok(!calls.some((args) => args[1] === "edit"));
  const unavailable = (args) => {
    if (args[1].endsWith("git/ref/heads/j1-code")) return JSON.stringify({ object: { sha } });
    const error = new Error("unavailable");
    error.stderr = "HTTP 503";
    throw error;
  };
  assert.throws(
    () =>
      publishRelease(
        directory,
        version,
        { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha },
        unavailable,
      ),
    /unavailable/,
  );
});
