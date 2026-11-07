// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BotId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
const state = vi.hoisted(() => ({
  recognition: null as null | ((event: Record<string, unknown>) => void),
  voice: null as null | ((event: Record<string, unknown>) => void),
  status: null as null | { state: string; text: string | null },
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  speak: vi.fn(),
  voiceStop: vi.fn(),
  refresh: vi.fn(),
  send: vi.fn(),
  counter: 0,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => new Map([["env", { settings: { bots: { bot: { voiceURI: "chosen" } } } }]]),
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.status, error: null, refresh: state.refresh }),
}));
vi.mock("../../state/botCallTurn", () => ({ botCallTurn: () => ({}) }));
vi.mock("expo-audio", () => ({
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: unknown }) => createElement("div", null, children as never),
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: unknown }) => createElement("span", null, children as never),
}));
vi.mock("../../components/MaterialButton", () => ({
  MaterialButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { onClick: onPress, disabled }, label),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "voice-session" }));
vi.mock("../../native/iosLiveDictation", () => ({
  iosLiveDictation: null,
  nextIOSLiveDictationSession: () => 0,
}));
vi.mock("../../native/androidDictation", () => ({
  androidDictation: {
    startDictation: state.start,
    stopDictation: state.stop,
    cancelDictation: state.cancel,
    addListener: (_: string, f: typeof state.recognition) => {
      state.recognition = f;
      return {
        remove() {
          state.recognition = null;
        },
      };
    },
  },
  nextAndroidDictationSession: () => ++state.counter,
}));
vi.mock("../../native/botVoice", () => ({
  botVoice: {
    speak: state.speak,
    stop: state.voiceStop,
    addListener: (_: string, f: typeof state.voice) => {
      state.voice = f;
      return {
        remove() {
          state.voice = null;
        },
      };
    },
  },
}));
import { BotCallControl } from "./BotCallControl";
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
  state.recognition = null;
  state.voice = null;
  state.status = null;
  state.counter = 0;
  state.start.mockReset().mockResolvedValue(undefined);
  state.stop.mockReset();
  state.cancel.mockReset();
  state.speak.mockReset().mockResolvedValue(undefined);
  state.voiceStop.mockReset();
  state.refresh.mockReset();
  state.send.mockReset().mockResolvedValue(MessageId.make("sent"));
  active.mockReset();
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
it("listens, closes the microphone, sends, and speaks only the completed turn", async () => {
  await act(() => render());
  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
  });
  expect(state.start).toHaveBeenCalledWith(1);
  await act(() => state.recognition?.({ sessionId: 1, type: "partial", text: "hello" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(state.stop).toHaveBeenCalledWith(1);
  await act(() => state.recognition?.({ sessionId: 1, type: "final", text: "hello" }));
  expect(state.send).not.toHaveBeenCalled();
  await act(async () => {
    state.recognition?.({ sessionId: 1, type: "end" });
    await Promise.resolve();
  });
  expect(state.send).toHaveBeenCalledWith("hello");
  expect(container.textContent).toContain("waiting");
  state.status = { state: "completed", text: "response" };
  await act(() => render("2"));
  expect(state.speak).toHaveBeenCalledWith("response", "chosen", "voice-session");
  expect(state.start).toHaveBeenCalledTimes(1);
  await act(async () => {
    state.voice?.({ sessionId: "voice-session", type: "end" });
    await Promise.resolve();
  });
  expect(state.start).toHaveBeenCalledTimes(2);
});
it("stops listening if an approval or user input is required", async () => {
  await act(() => render());
  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
  });
  await act(() => render("2", true));
  expect(state.cancel).toHaveBeenCalledWith(1);
  expect(state.send).not.toHaveBeenCalled();
});

it("surfaces send failure instead of waiting for a reply", async () => {
  state.send.mockResolvedValue(null);
  await act(() => render());
  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
  });
  await act(() => state.recognition?.({ sessionId: 1, type: "partial", text: "hello" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  await act(() => state.recognition?.({ sessionId: 1, type: "final", text: "hello" }));
  await act(async () => {
    state.recognition?.({ sessionId: 1, type: "end" });
    await Promise.resolve();
  });
  expect(container.textContent).toContain("The message could not be sent.");
  expect(state.speak).not.toHaveBeenCalled();
});
it("hangs up without sending late microphone results", async () => {
  await act(() => render());
  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
  });
  await act(() => state.recognition?.({ sessionId: 1, type: "partial", text: "unsent" }));
  await act(() => container.querySelector("button")!.click());
  await act(async () => {
    state.recognition?.({ sessionId: 1, type: "final", text: "unsent" });
    state.recognition?.({ sessionId: 1, type: "end" });
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(state.cancel).toHaveBeenCalledWith(1);
  expect(state.send).not.toHaveBeenCalled();
});
