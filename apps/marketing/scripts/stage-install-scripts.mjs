// Remove legacy generated copies: upstream installers fetch upstream releases,
// so the J1 site directs users to its own release page and source build guide.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const marketingDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
for (const name of ["install.sh", "install.ps1"]) {
  NodeFS.rmSync(NodePath.join(marketingDir, "public", name), { force: true });
}
