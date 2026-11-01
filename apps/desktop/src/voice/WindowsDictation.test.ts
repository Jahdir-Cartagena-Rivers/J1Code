// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
import { startWindowsDictation, cancelWindowsDictation } from "./WindowsDictation.ts";

afterEach(() => vi.clearAllMocks());
function child() {
  const process = Object.assign(new NodeEvents.EventEmitter(), {
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    kill: vi.fn(),
  });
  mock.spawn.mockReturnValue(process);
  return process;
}
describe("Windows dictation process lifecycle", () => {
  it("returns UTF-8 text and runs only a fixed hidden recognition script", async () => {
    const process = child();
    const result = startWindowsDictation("request-one", "win32");
    process.stdout.write("A café project");
    process.emit("close", 0);
    await expect(result).resolves.toBe("A café project");
    expect(mock.spawn).toHaveBeenCalledWith(
      "powershell.exe",
      expect.not.arrayContaining(["request-one"]),
      expect.objectContaining({ windowsHide: true }),
    );
  });
  it("cancels only the captured request and rejects overlapping recording", async () => {
    const process = child();
    const result = startWindowsDictation("active", "win32");
    await expect(startWindowsDictation("second", "win32")).rejects.toThrow("already listening");
    cancelWindowsDictation("unrelated");
    expect(process.kill).not.toHaveBeenCalled();
    cancelWindowsDictation("active");
    expect(process.kill).toHaveBeenCalledOnce();
    process.emit("close", null);
    await expect(result).rejects.toThrow("Dictation stopped");
  });
  it("releases a failed process so another attempt can start", async () => {
    const process = child();
    const first = startWindowsDictation("failed", "win32");
    process.emit("error", new Error("Could not start speech engine"));
    await expect(first).rejects.toThrow("speech engine");
    const next = child();
    const second = startWindowsDictation("retry", "win32");
    next.emit("close", 0);
    await expect(second).resolves.toBe("");
  });
});
