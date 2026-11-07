// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BotId, EnvironmentId } from "@t3tools/contracts";
const state = vi.hoisted(() => ({
  auto: true,
  speak: vi.fn(),
  stop: vi.fn(),
  listener: null as null | ((event: { sessionId: string; type: string }) => void),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map([
      ["env", { settings: { bots: { bot: { voiceURI: "voice", voiceAutoPlay: state.auto } } } }],
    ]),
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: unknown }) => createElement("div", null, children as never),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: unknown }) => createElement("span", null, children as never),
}));
vi.mock("../../components/MaterialButton", () => ({
  MaterialButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { onClick: onPress }, label),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "session" }));
vi.mock("../../native/botVoice", () => ({
  botVoice: {
    speak: state.speak,
    stop: state.stop,
    addListener: (_: string, callback: typeof state.listener) => {
      state.listener = callback;
      return {
        remove: () => {
          state.listener = null;
        },
      };
    },
  },
}));
import { BotVoiceControl } from "./BotVoiceControl";
let root: Root;
let container: HTMLDivElement;
const render = (messageId: string, text: string) =>
  root.render(
    <BotVoiceControl
      environmentId={EnvironmentId.make("env")}
      botId={BotId.make("bot")}
      messageId={messageId}
      text={text}
    />,
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.speak.mockReset().mockResolvedValue(undefined);
  state.stop.mockReset();
  state.auto = true;
  state.listener = null;
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("plays a new completed reply with the selected voice, without replaying history", async () => {
  await act(() => render("old", "Old reply"));
  expect(state.speak).not.toHaveBeenCalled();
  await act(() => render("new", "New reply"));
  expect(state.speak).toHaveBeenCalledWith("New reply", "voice", "session");
  expect(container.textContent).toContain("Stop voice");
  await act(() => state.listener?.({ sessionId: "other", type: "end" }));
  expect(container.textContent).toContain("Stop voice");
  await act(() => state.listener?.({ sessionId: "session", type: "end" }));
  expect(container.textContent).toContain("Read last reply");
});
it("stops active playback when the conversation unmounts", async () => {
  state.auto = false;
  await act(() => render("old", "Reply"));
  await act(() => container.querySelector("button")!.click());
  await act(() => root.unmount());
  expect(state.stop).toHaveBeenCalledTimes(1);
  root = createRoot(container);
});
