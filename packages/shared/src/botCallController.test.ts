import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createBotCallController, type BotCallPorts } from "./botCallController.ts";
afterEach(() => vi.useRealTimers());
function fixture() {
  const ports: BotCallPorts = {
    listen: vi.fn().mockResolvedValue(undefined),
    finishListening: vi.fn(),
    cancelListening: vi.fn(),
    send: vi.fn().mockResolvedValue("user"),
    speak: vi.fn().mockResolvedValue(undefined),
    stopSpeaking: vi.fn(),
    onState: vi.fn(),
  };
  return { ports, call: createBotCallController(ports, 1000) };
}
describe("bot call controller", () => {
  it("endpoints speech before sending and does not listen while awaiting or speaking", async () => {
    vi.useFakeTimers();
    const { call, ports } = fixture();
    let completeSpeech!: () => void;
    vi.mocked(ports.speak).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          completeSpeech = resolve;
        }),
    );
    call.dispatch({ type: "start" });
    call.dispatch({ type: "partial", generation: 1, text: "hello" });
    await vi.advanceTimersByTimeAsync(999);
    expect(ports.finishListening).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ports.finishListening).toHaveBeenCalledWith(1);
    call.dispatch({ type: "final", generation: 1, text: "hello" });
    await Promise.resolve();
    expect(call.getState().phase).toBe("waiting");
    expect(ports.send).toHaveBeenCalledWith("hello");
    call.dispatch({ type: "reply", generation: 1, messageId: "user", text: "hi" });
    expect(call.getState().phase).toBe("speaking");
    expect(ports.listen).toHaveBeenCalledTimes(1);
    completeSpeech();
    await Promise.resolve();
    expect(ports.listen).toHaveBeenCalledTimes(2);
    expect(call.getState().generation).toBe(2);
    call.dispose();
  });
  it("stops capture and ignores late results after a user hangs up", async () => {
    vi.useFakeTimers();
    const { call, ports } = fixture();
    call.dispatch({ type: "start" });
    call.dispatch({ type: "partial", generation: 1, text: "draft" });
    call.dispatch({ type: "stop" });
    await vi.advanceTimersByTimeAsync(2000);
    call.dispatch({ type: "final", generation: 1, text: "draft" });
    expect(ports.cancelListening).toHaveBeenCalledWith(1);
    expect(ports.send).not.toHaveBeenCalled();
    expect(ports.finishListening).not.toHaveBeenCalled();
    expect(call.getState().phase).toBe("idle");
  });
  it("surfaces a synchronous microphone failure and attempts cleanup", () => {
    const { call, ports } = fixture();
    vi.mocked(ports.listen).mockImplementation(() => {
      throw new Error("microphone unavailable");
    });
    call.dispatch({ type: "start" });
    expect(call.getState().phase).toBe("error");
    expect(ports.cancelListening).toHaveBeenCalledWith(1);
    call.dispose();
  });
  it("does not send when capture returns no final words", async () => {
    vi.useFakeTimers();
    const { call, ports } = fixture();
    call.dispatch({ type: "start" });
    call.dispatch({ type: "partial", generation: 1, text: "perhaps" });
    await vi.advanceTimersByTimeAsync(1000);
    call.dispatch({ type: "final", generation: 1, text: "" });
    expect(ports.send).not.toHaveBeenCalled();
    expect(call.getState().phase).toBe("listening");
    call.dispose();
  });
});
