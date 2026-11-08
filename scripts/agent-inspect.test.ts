import { describe, expect, it } from "vite-plus/test";
import { inspectDeclarations } from "./agent-inspect.ts";

describe("bounded declaration inspection", () => {
  it("finds declarations and methods without dumping function bodies or local variables", () => {
    const source = `export class Owner {
  async launch() { const secret = 'do not print'; return secret; }
}
export const settings = { retries: 2 };
export function helper() { const nested = () => {}; }
`;
    const result = inspectDeclarations("fixture.ts", source);
    expect(result.symbols.map((symbol) => symbol.name)).toEqual([
      "Owner",
      "launch",
      "settings",
      "helper",
    ]);
    expect(result.symbols[1]).toMatchObject({ line: 2, endLine: 2 });
    expect(JSON.stringify(result)).not.toContain("do not print");
  });
  it("filters before bounding and explicitly reports omitted results", () => {
    const source =
      "export const other = 0; export function readOne() {} export function readTwo() {}";
    expect(inspectDeclarations("fixture.ts", source, "READ", 1)).toMatchObject({
      total: 2,
      omitted: 1,
      symbols: [{ name: "readOne" }],
    });
  });
  it("finds a named implementation nested inside an Effect-style closure when explicitly queried", () => {
    const source =
      "export const make = Effect.gen(function* () { const sendTurn = Effect.fn(function* () {}); return { sendTurn }; });";
    expect(inspectDeclarations("fixture.ts", source, "sendTurn").symbols).toMatchObject([
      { name: "sendTurn", kind: "VariableDeclaration" },
    ]);
    expect(inspectDeclarations("fixture.ts", source).symbols.map((item) => item.name)).toEqual([
      "make",
    ]);
  });
});
