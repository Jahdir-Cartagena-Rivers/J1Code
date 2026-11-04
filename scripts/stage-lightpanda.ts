import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
const run = NodeUtil.promisify(NodeChildProcess.execFile);
export const LIGHTPANDA_SOURCE = "090488933101502abe191bdde4bca837c6db1911";
const base =
  "https://github.com/Jahdir-Cartagena-Rivers/browser/releases/download/windows-native-0904889/";
export function verifyNativeHash(bytes: Uint8Array, expected: string) {
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Lightpanda integrity check failed");
}
/** Stage only pinned release artifacts. A missing binary or notice fails the build. */
export async function stageLightpanda(destination: string) {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-lightpanda-package-"));
  const download = async (name: string, hash: string) => {
    const response = await fetch(base + name);
    if (!response.ok) throw new Error(`Lightpanda download failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verifyNativeHash(bytes, hash);
    const file = NodePath.join(scratch, name);
    await NodeFSP.writeFile(file, bytes);
    return file;
  };
  try {
    const archive = await download(
      "lightpanda-windows-x64-0904889.zip",
      "1e1c463d019bba19ffefef3e6166b00e03bf00b353008fc3370d3d289ad8abae",
    );
    const source = await download(
      "lightpanda-windows-source-0904889.zip",
      "1642099a9a445d63f74c61d374f1d09fdea41e185b19668bc9be5135e2722b22",
    );
    await NodeFSP.mkdir(destination, { recursive: true });
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:J1_NATIVE_ARCHIVE -DestinationPath $env:J1_NATIVE_DESTINATION -Force",
      ],
      {
        windowsHide: true,
        env: { ...process.env, J1_NATIVE_ARCHIVE: archive, J1_NATIVE_DESTINATION: destination },
      },
    );
    for (const name of [
      "LICENSE",
      "LICENSING.md",
      "THIRD_PARTY_NOTICES.txt",
      "SOURCE.txt",
      "WINDOWS.md",
      "SHA256SUMS.txt",
      "licenses/rust",
    ])
      await NodeFSP.access(NodePath.join(destination, name));
    verifyNativeHash(
      await NodeFSP.readFile(NodePath.join(destination, "lightpanda.exe")),
      "45539dfe4b8094d7c353a9dc616076b69ac2e7c29f896e929fb1dd5e406fbf29",
    );
    await NodeFSP.copyFile(source, NodePath.join(destination, NodePath.basename(source)));
    await NodeFSP.writeFile(
      NodePath.join(destination, "j1-native-provenance.json"),
      JSON.stringify(
        {
          sourceCommit: LIGHTPANDA_SOURCE,
          sourceUrl: "https://github.com/Jahdir-Cartagena-Rivers/browser/tree/" + LIGHTPANDA_SOURCE,
          executableSha256: "45539dfe4b8094d7c353a9dc616076b69ac2e7c29f896e929fb1dd5e406fbf29",
        },
        null,
        2,
      ),
    );
    await validatePackagedLightpanda(destination);
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

export async function validatePackagedLightpanda(directory: string) {
  for (const name of [
    "LICENSE",
    "LICENSING.md",
    "THIRD_PARTY_NOTICES.txt",
    "SOURCE.txt",
    "WINDOWS.md",
    "SHA256SUMS.txt",
    "licenses/rust",
    "lightpanda-windows-source-0904889.zip",
    "j1-native-provenance.json",
  ])
    await NodeFSP.access(NodePath.join(directory, name));
  const files = await NodeFSP.readdir(directory, { recursive: true });
  if (files.some((name) => name.toLowerCase().endsWith(".dll")))
    throw new Error("Unexpected DLL in native browser distribution");
  verifyNativeHash(
    await NodeFSP.readFile(NodePath.join(directory, "lightpanda.exe")),
    "45539dfe4b8094d7c353a9dc616076b69ac2e7c29f896e929fb1dd5e406fbf29",
  );
}
