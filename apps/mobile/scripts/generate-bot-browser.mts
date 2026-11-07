import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";
const mobileRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
export async function generateBotBrowserScript() {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      target: "es2022",
      minify: true,
      lib: {
        entry: NodePath.join(mobileRoot, "src/features/bots/browser-view.browser.ts"),
        name: "J1BotBrowser",
        formats: ["iife"],
      },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const chunk = bundles
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
    .find((output) => output.type === "chunk");
  if (!chunk) throw new Error("Bot browser did not emit a view script.");
  const root = NodePath.join(mobileRoot, ".generated/bot-browser");
  await NodeFSP.mkdir(root, { recursive: true });
  for (const [name, contents] of [
    ["index.js", `module.exports = ${JSON.stringify(chunk.code)};\n`],
    ["package.json", '{"main":"index.js"}\n'],
  ] as const) {
    const dest = NodePath.join(root, name);
    if ((await NodeFSP.readFile(dest, "utf8").catch(() => null)) !== contents)
      await NodeFSP.writeFile(dest, contents);
  }
}
