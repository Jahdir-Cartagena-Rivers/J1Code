// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
import {
  startWindowsDictation,
  cancelWindowsDictation,
  stopWindowsDictation,
  getWindowsDictationText,
  getWindowsDictationLevel,
} from "./WindowsDictation.ts";

afterEach(() => vi.clearAllMocks());
function child() {
  const process = Object.assign(new NodeEvents.EventEmitter(), {
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    stdin: new NodeStream.PassThrough(),
    kill: vi.fn(),
  });
  mock.spawn.mockReturnValue(process);
  return process;
}
describe("Windows dictation process lifecycle", () => {
  it("keeps phrases available until finish and returns the accumulated text", async () => {
    const process = child();
    const result = startWindowsDictation("long-session", "win32");
    process.stdout.write(`F\t${Buffer.from("First phrase").toString("base64")}\n`);
    process.stdout.write(`P\t${Buffer.from("First phrase Second").toString("base64")}\n`);
    process.stdout.write(`L\t${Buffer.from("37").toString("base64")}\n`);
    expect(getWindowsDictationText("long-session")).toBe("First phrase Second");
    expect(getWindowsDictationLevel("long-session")).toBe(37);
    stopWindowsDictation("long-session");
    expect(process.kill).not.toHaveBeenCalled();
    process.stdout.write(`F\t${Buffer.from("First phrase Second phrase").toString("base64")}\n`);
    process.emit("close", 0);
    await expect(result).resolves.toBe("First phrase Second phrase");
  });
  it("rejects a failed finish rather than claiming an incomplete transcript", async () => {
    const process = child();
    const result = startWindowsDictation("failed-finish", "win32");
    process.stdout.write(`P\t${Buffer.from("unfinished").toString("base64")}\n`);
    stopWindowsDictation("failed-finish");
    process.stderr.write("Speech recognition did not finish.");
    process.emit("close", 1);
    await expect(result).rejects.toThrow("Speech recognition did not finish");
  });
  it("reassembles split recognition messages and replaces interim words", async () => {
    const process = child();
    const result = startWindowsDictation("split-events", "win32");
    const interim = Buffer.from("hello world").toString("base64");
    process.stdout.write(`P\t${interim.slice(0, 3)}`);
    expect(getWindowsDictationText("split-events")).toBe("");
    process.stdout.write(`${interim.slice(3)}\n`);
    expect(getWindowsDictationText("split-events")).toBe("hello world");
    process.stdout.write(`F\t${Buffer.from("hello there").toString("base64")}\n`);
    stopWindowsDictation("split-events");
    process.emit("close", 0);
    await expect(result).resolves.toBe("hello there");
  });
  it("returns UTF-8 text and runs only a fixed hidden recognition script", async () => {
    const process = child();
    const result = startWindowsDictation("request-one", "win32");
    process.stdout.write(`F\t${Buffer.from("A café project").toString("base64")}\n`);
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
