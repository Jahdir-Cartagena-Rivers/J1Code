import { describe, expect, it, vi } from "vite-plus/test";
import { createBotCallMicrophone, type CallRecognitionEvent } from "./botCallMicrophone";
function fixture(androidSegments = false) {
  let listener: (event: CallRecognitionEvent) => void = () => {};
  const recognition = {
    startDictation: vi.fn().mockResolvedValue(undefined),
    stopDictation: vi.fn(),
    cancelDictation: vi.fn(),
    addListener: vi.fn((_name, next) => {
      listener = next;
      return { remove: vi.fn() };
    }),
  };
  const callbacks = { partial: vi.fn(), final: vi.fn(), failed: vi.fn() };
  const microphone = createBotCallMicrophone({
    recognition,
    requestPermission: async () => true,
    nextSession: () => 7,
    androidSegments,
    callbacks,
  });
  return {
    recognition,
    callbacks,
    microphone,
    emit: (event: Omit<CallRecognitionEvent, "sessionId"> & { sessionId?: number }) =>
      listener({ sessionId: 7, ...event }),
  };
}
describe("bot call microphone", () => {
  it("waits until native capture ends before handing over the final words", async () => {
    const f = fixture();
    await f.microphone.listen(1);
    f.emit({ type: "partial", text: "hello" });
    f.microphone.finish(1);
    f.emit({ type: "final", text: "hello there" });
    expect(f.callbacks.final).not.toHaveBeenCalled();
    f.emit({ type: "end" });
    expect(f.callbacks.final).toHaveBeenCalledWith(1, "hello there");
    expect(f.recognition.stopDictation).toHaveBeenCalledWith(7);
    f.microphone.dispose();
  });
  it("joins Android segments once and ignores late callbacks after cancellation", async () => {
    const f = fixture(true);
    await f.microphone.listen(2);
    f.emit({ type: "final", text: "first" });
    f.emit({ type: "partial", text: "second" });
    expect(f.callbacks.partial).toHaveBeenLastCalledWith(2, "first second");
    f.microphone.finish(2);
    f.emit({ type: "final", text: "second" });
    f.emit({ type: "end" });
    expect(f.callbacks.final).toHaveBeenCalledWith(2, "first second");
    await f.microphone.listen(3);
    f.microphone.cancel(3);
    f.emit({ type: "final", text: "late" });
    f.emit({ type: "end" });
    expect(f.callbacks.final).toHaveBeenCalledTimes(1);
    f.microphone.dispose();
  });
  it("uses the committed Android segment when stopped between recognition cycles", async () => {
    const f = fixture(true);
    await f.microphone.listen(1);
    f.emit({ type: "final", text: "complete" });
    f.microphone.finish(1);
    f.emit({ type: "end" });
    expect(f.callbacks.final).toHaveBeenCalledWith(1, "complete");
    f.microphone.dispose();
  });
  it("reports an unexpected end without sending an incomplete utterance", async () => {
    const f = fixture();
    await f.microphone.listen(1);
    f.emit({ type: "end" });
    expect(f.callbacks.failed).toHaveBeenCalledOnce();
    expect(f.callbacks.final).not.toHaveBeenCalled();
    f.microphone.dispose();
  });
  it("does not start recording if cancelled while permission is pending", async () => {
    let grant!: (value: boolean) => void;
    const recognition = {
      startDictation: vi.fn().mockResolvedValue(undefined),
      stopDictation: vi.fn(),
      cancelDictation: vi.fn(),
      addListener: vi.fn(() => ({ remove: vi.fn() })),
    };
    const microphone = createBotCallMicrophone({
      recognition,
      requestPermission: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
      nextSession: () => 7,
      androidSegments: false,
      callbacks: { partial: vi.fn(), final: vi.fn(), failed: vi.fn() },
    });
    const started = microphone.listen(1);
    microphone.cancel(1);
    grant(true);
    await started;
    expect(recognition.startDictation).not.toHaveBeenCalled();
    microphone.dispose();
  });
});
