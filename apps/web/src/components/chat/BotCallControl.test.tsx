// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BotId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
const state = vi.hoisted(() => ({
  status: null as null | { state: string; text: string | null },
  refresh: vi.fn(),
  send: vi.fn(),
  start: vi.fn(),
  read: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  speak: vi.fn(),
  speechCancel: vi.fn(),
  finish: null as null | ((text: string) => void),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => new Map([["env", { settings: { bots: { bot: { voiceURI: "chosen" } } } }]]),
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.status, error: null, refresh: state.refresh }),
}));
vi.mock("../../state/botCallTurn", () => ({ botCallTurn: () => ({}) }));
vi.mock("../../lib/utils", () => ({ newThreadId: () => "capture-id" }));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: unknown;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children as never}
    </button>
  ),
}));
import { BotCallControl } from "./BotCallControl";
class Utterance {
  voice: unknown;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}
let root: Root;
let container: HTMLDivElement;
const active = vi.fn();
function render(revision = "1", blocked = false) {
  root.render(
    <BotCallControl
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("thread")}
      botId={BotId.make("bot")}
      revision={revision}
      blocked={blocked}
      startDisabled={false}
      onActiveChange={active}
      onSendVoice={state.send}
    />,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  state.status = null;
  state.finish = null;
  state.start.mockReset().mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        state.finish = resolve;
      }),
  );
  state.read.mockReset().mockResolvedValue("hello");
  state.stop.mockReset().mockResolvedValue(undefined);
  state.cancel.mockReset().mockResolvedValue(undefined);
  state.speak.mockReset();
  state.speechCancel.mockReset();
  state.send.mockReset().mockResolvedValue(MessageId.make("sent"));
  state.refresh.mockReset();
  active.mockReset();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      getClientPlatform: () => "win32",
      startDictation: state.start,
      getDictationText: state.read,
      stopDictation: state.stop,
      cancelDictation: state.cancel,
    },
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => [{ voiceURI: "chosen" }],
      speak: state.speak,
      cancel: state.speechCancel,
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("closes Windows capture before sending and waits for the matched response before speaking", async () => {
  await act(() => render());
  await act(() => container.querySelector("button")!.click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1550);
  });
  expect(state.stop).toHaveBeenCalledWith({ requestId: "capture-id" });
  expect(state.send).not.toHaveBeenCalled();
  await act(async () => {
    state.finish?.("hello");
    await Promise.resolve();
  });
  expect(state.send).toHaveBeenCalledWith("hello");
  expect(container.textContent).toContain("waiting");
  state.status = { state: "completed", text: "reply" };
  await act(() => render("2"));
  const utterance = state.speak.mock.calls[0]?.[0] as Utterance;
  expect(utterance.text).toBe("reply");
  await act(async () => {
    utterance.onend?.();
    await Promise.resolve();
  });
  expect(state.start).toHaveBeenCalledTimes(2);
});
it("cancels capture when an approval becomes pending", async () => {
  await act(() => render());
  await act(() => container.querySelector("button")!.click());
  await act(() => render("2", true));
  expect(state.cancel).toHaveBeenCalledWith({ requestId: "capture-id" });
  expect(state.send).not.toHaveBeenCalled();
});
