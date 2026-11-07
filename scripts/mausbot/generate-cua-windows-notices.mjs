import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const pin = "fc188250b4ca8549b8e61f937fdb1fb560770e86";
const [source, reports, destination, interLicense] = process.argv.slice(2);
if (!source || !reports || !destination || !interLicense)
  throw new Error(
    "Supply pinned Cua source, cargo-about reports directory, new output directory, and Inter OFL file.",
  );
if (
  NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
    windowsHide: true,
  }).trim() !== pin
)
  throw new Error("Cua notice source pin does not match.");
const hash = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const roots = ["cua-driver", "cua-driver-sdk", "cua-driver-uia", "cursor-theme-cli"];
const crates = new Map();
const licenses = new Map();
const reportHashes = {};
for (const root of roots) {
  const bytes = await NodeFSP.readFile(NodePath.join(reports, `j1-${root}-windows-about.json`));
  const report = JSON.parse(bytes);
  reportHashes[root] = hash(bytes);
  const covered = new Set(
    report.licenses.flatMap((license) =>
      license.used_by.map(({ crate }) => `${crate.name}@${crate.version}`),
    ),
  );
  for (const { package: pkg, license } of report.crates) {
    if (!pkg.source) continue; // Workspace material follows the pinned repository's MIT grant below.
    const key = `${pkg.name}@${pkg.version}`;
    if (!covered.has(key)) throw new Error(`Missing Windows dependency notice: ${key}`);
    if (pkg.source !== "registry+https://github.com/rust-lang/crates.io-index")
      throw new Error(`Review non-registry dependency before distribution: ${key}`);
    const previous = crates.get(key);
    if (previous && previous.license !== license)
      throw new Error(`Conflicting license expression: ${key}`);
    crates.set(key, {
      name: pkg.name,
      version: pkg.version,
      license,
      repository: pkg.repository ?? null,
      source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`,
      roots: [...new Set([...(previous?.roots ?? []), root])].sort(),
    });
  }
  for (const license of report.licenses) {
    if (!license.id || !license.text.trim()) throw new Error("Incomplete license report.");
    const key = `${license.id}:${hash(license.text)}`;
    const previous = licenses.get(key);
    licenses.set(key, {
      id: license.id,
      name: license.name,
      text: license.text,
      usedBy: [
        ...new Set([
          ...(previous?.usedBy ?? []),
          ...license.used_by.map(({ crate }) => `${crate.name}@${crate.version}`),
        ]),
      ].sort(),
    });
  }
}
const rust = NodePath.join(source, "libs/cua-driver/rust");
const fontHash = hash(
  await NodeFSP.readFile(NodePath.join(rust, "crates/cursor-overlay/assets/Inter.ttf")),
);
if (fontHash !== "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031")
  throw new Error("Review the embedded font license before updating its pin.");
const sourceUrl = `https://github.com/trycua/cua/tree/${pin}`;
const sorted = [...licenses.values()].sort(
  (a, b) => a.id.localeCompare(b.id) || hash(a.text).localeCompare(hash(b.text)),
);
await NodeFSP.mkdir(NodePath.dirname(NodePath.resolve(destination)), { recursive: true });
await NodeFSP.mkdir(destination); // Refuse to overwrite a previous reviewed distribution record.
await NodeFSP.copyFile(
  NodePath.join(source, "LICENSE.md"),
  NodePath.join(destination, "LICENSE.md"),
);
await NodeFSP.copyFile(interLicense, NodePath.join(destination, "Inter-OFL-1.1.txt"));
await NodeFSP.copyFile(
  NodePath.join(source, "libs/cua-driver/scripts/node-runtime-NOTICE.md"),
  NodePath.join(destination, "NODE_RUNTIME_NOTICE.md"),
);
const mpl = sorted.find((license) => license.id === "MPL-2.0");
if (!mpl) throw new Error("The native Node runtime requires the MPL-2.0 text.");
await NodeFSP.writeFile(NodePath.join(destination, "MPL-2.0.txt"), mpl.text);
await NodeFSP.writeFile(
  NodePath.join(destination, "THIRD_PARTY_NOTICES.txt"),
  [
    "Cua Driver 0.28.2 Windows x64 distribution notices",
    `Corresponding source: ${sourceUrl}`,
    "The Cua workspace code follows LICENSE.md. Embedded Inter follows Inter-OFL-1.1.txt.",
    "The Node compatibility runtime follows NODE_RUNTIME_NOTICE.md and MPL-2.0.txt.",
    `Its deterministic build transformations: ${sourceUrl}/libs/cua-driver/scripts/build-node-runtime.mjs`,
    "Its pinned source dependency: https://registry.npmjs.org/uniffi-bindgen-react-native/-/uniffi-bindgen-react-native-0.31.0-3.tgz",
    "Registry source downloads and exact versions are listed in DEPENDENCIES.json, including MPL-covered components.",
    ...sorted.map(
      (license) =>
        `\n${"=".repeat(72)}\n${license.id} - ${license.name}\nUsed by: ${license.usedBy.join(", ")}\n\n${license.text}`,
    ),
  ].join("\n\n") + "\n",
);
await NodeFSP.writeFile(
  NodePath.join(destination, "DEPENDENCIES.json"),
  JSON.stringify(
    {
      source: sourceUrl,
      version: "0.28.2",
      target: "x86_64-pc-windows-msvc",
      roots,
      generator:
        "cargo-about 0.8.4, root-scoped --locked --target x86_64-pc-windows-msvc --format json",
      cargoAboutArchiveSha256: "d5c38fb914bbad57c6a7d58c4847315bc3fe11efbe4fb51b3c515f997a56ceb7",
      cargoLockSha256: hash(await NodeFSP.readFile(NodePath.join(rust, "Cargo.lock"))),
      embeddedInterSha256: fontHash,
      reportHashes,
      crates: [...crates.values()].sort((a, b) =>
        `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
      ),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Generated ${crates.size} Windows registry dependency records and ${licenses.size} license notices.`,
);
