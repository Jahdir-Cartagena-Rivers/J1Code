// @effect-diagnostics nodeBuiltinImport:off - Standalone CLI emits bounded JSON, not application logs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as ts from "typescript-legacy";

/** Lists named declarations without walking dependencies, creating an index, or printing bodies. */
export function inspectDeclarations(file: string, text: string, query = "", limit = 80) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const symbols: { name: string; kind: string; line: number; endLine: number }[] = [];
  let total = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const name = node.name?.getText(source);
      if (name && name.toLowerCase().includes(query.toLowerCase())) {
        total++;
        if (symbols.length < limit)
          symbols.push({
            name,
            kind: ts.SyntaxKind[node.kind]!,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            endLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
          });
      }
      // Keep the default outline small. An explicit query also searches the
      // Effect.gen/Effect.fn closures that own much of this repository's logic.
      if (!query && !ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { file, symbols, total, omitted: Math.max(0, total - symbols.length) };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: { query: { type: "string" }, limit: { type: "string", default: "80" } },
  });
  if (!positionals.length)
    throw new Error(
      "Usage: node scripts/agent-inspect.ts <file> [<file> ...] [--query name] [--limit 80]",
    );
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || positionals.length > 10)
    throw new Error("Use 1–10 files and a limit between 1 and 200.");
  for (const file of positionals) {
    const resolved = NodePath.resolve(file);
    if ((await NodeFSP.stat(resolved)).size > 2 * 1024 * 1024)
      throw new Error(`File exceeds 2 MiB: ${file}`);
    process.stdout.write(
      JSON.stringify(
        inspectDeclarations(file, await NodeFSP.readFile(resolved, "utf8"), values.query, limit),
      ) + "\n",
    );
  }
}
