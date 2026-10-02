const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  releaseIdentity,
  artifactNames,
  validateArtifacts,
  assertPublishable,
  publishRelease,
} = require("./j1-release.cjs");

const version = "0.0.44-j1.11";
const sha = "a".repeat(40);
const repository = "example/J1Code";

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
  assert.equal(releaseIdentity("0.0.44-j1.10", "2").version, "0.0.44-j1.12");
  assert.deepEqual(releaseIdentity("0.0.44-j1.10", "1"), releaseIdentity("0.0.44-j1.10", "1"));
  for (const run of ["", "0", "-1", "1.5", "x", "9007199254740993"]) {
    assert.throws(() => releaseIdentity("0.0.44-j1.10", run));
  }
  assert.throws(() => releaseIdentity("0.0.44", "1"));
  assert.throws(() => releaseIdentity("0.0.44-j1.65535", "1"));
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
      };
    if (args[1] === "upload")
      release.assets = args
        .slice(args.indexOf("--clobber") + 1)
        .map((file) => ({ name: path.basename(file), size: fs.statSync(file).size }));
    if (args[1] === "edit") release.draft = false;
    return "";
  };
  assert.equal(
    publishRelease(directory, version, { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha }, fakeGh),
    "https://example.test/release",
  );
  const mutations = calls
    .filter((args) => args[0] === "release" && args[1] !== "view")
    .map((args) => args[1]);
  assert.deepEqual(mutations, ["create", "upload", "edit"]);
  assert.ok(calls.at(-1).includes("--draft=false"));
  calls.length = 0;
  assert.equal(
    publishRelease(directory, version, { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha }, fakeGh),
    "https://example.test/release",
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
