import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createWebCallMicrophone } from "./botCallMicrophone.ts";
afterEach(() => vi.useRealTimers());
describe("desktop call microphone", () => {
  it("waits for native dictation to close before returning final text", async () => {
    vi.useFakeTimers();
    let complete!: (text: string) => void;
    const native = {
      startDictation: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            complete = resolve;
          }),
      ),
      getDictationText: vi.fn().mockResolvedValue("hello"),
      stopDictation: vi.fn().mockResolvedValue(undefined),
      cancelDictation: vi.fn().mockResolvedValue(undefined),
    };
    const callbacks = { partial: vi.fn(), final: vi.fn(), failed: vi.fn() };
    const mic = createWebCallMicrophone({ native, nextId: () => "id", language: "en", callbacks });
    await mic.listen(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(callbacks.partial).toHaveBeenCalledWith(1, "hello");
    mic.finish(1);
    expect(callbacks.final).not.toHaveBeenCalled();
    complete("hello there");
    await Promise.resolve();
    expect(callbacks.final).toHaveBeenCalledWith(1, "hello there");
    expect(native.stopDictation).toHaveBeenCalledOnce();
    mic.dispose();
  });
  it("cancels native capture and ignores late output", async () => {
    vi.useFakeTimers();
    let complete!: (text: string) => void;
    const native = {
      startDictation: () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
      getDictationText: vi.fn().mockResolvedValue(""),
      stopDictation: vi.fn().mockResolvedValue(undefined),
      cancelDictation: vi.fn().mockResolvedValue(undefined),
    };
    const callbacks = { partial: vi.fn(), final: vi.fn(), failed: vi.fn() };
    const mic = createWebCallMicrophone({ native, nextId: () => "id", language: "en", callbacks });
    await mic.listen(1);
    mic.cancel(1);
    complete("late");
    await Promise.resolve();
    expect(native.cancelDictation).toHaveBeenCalledOnce();
    expect(callbacks.final).not.toHaveBeenCalled();
    mic.dispose();
  });
  it("cancels capture on a native read failure", async () => {
    vi.useFakeTimers();
    const native = {
      startDictation: () => new Promise<string>(() => {}),
      getDictationText: vi.fn().mockRejectedValue(new Error("read failed")),
      stopDictation: vi.fn().mockResolvedValue(undefined),
      cancelDictation: vi.fn().mockResolvedValue(undefined),
    };
    const callbacks = { partial: vi.fn(), final: vi.fn(), failed: vi.fn() };
    const mic = createWebCallMicrophone({ native, nextId: () => "id", language: "en", callbacks });
    await mic.listen(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(callbacks.failed).toHaveBeenCalledWith(1, "read failed");
    expect(native.cancelDictation).toHaveBeenCalledOnce();
    mic.dispose();
  });
});
it("restarts browser recognition and only submits finalized words after stop", async () => {
  const callbacks = { partial: vi.fn(), final: vi.fn(), failed: vi.fn() };
  const recognition = {
    lang: "",
    continuous: false,
    interimResults: false,
    onresult: null as
      | null
      | ((event: { results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }> }) => void),
    onerror: null as null | ((event: { error: string }) => void),
    onend: null as null | (() => void),
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
  };
  const mic = createWebCallMicrophone({
    createRecognition: () => recognition,
    nextId: () => "id",
    language: "en",
    callbacks,
  });
  await mic.listen(1);
  recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: "first" } }] });
  recognition.onend?.();
  expect(recognition.start).toHaveBeenCalledTimes(2);
  recognition.onresult?.({ results: [{ isFinal: false, 0: { transcript: "second" } }] });
  expect(callbacks.partial).toHaveBeenLastCalledWith(1, "first second");
  mic.finish(1);
  recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: "second" } }] });
  recognition.onend?.();
  expect(callbacks.final).toHaveBeenCalledWith(1, "first second");
  mic.dispose();
});
