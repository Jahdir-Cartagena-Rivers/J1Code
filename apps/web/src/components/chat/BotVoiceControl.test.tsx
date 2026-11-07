// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BotId, EnvironmentId } from "@t3tools/contracts";
const state = vi.hoisted(() => ({ auto: true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map([
      [
        "env",
        { settings: { bots: { bot: { voiceURI: "test-voice", voiceAutoPlay: state.auto } } } },
      ],
    ]),
}));
import { BotVoiceControl } from "./BotVoiceControl";
class Utterance extends EventTarget {
  text: string;
  voice: unknown;
  constructor(text: string) {
    super();
    this.text = text;
  }
}
let root: Root;
let container: HTMLDivElement;
const speak = vi.fn();
const cancel = vi.fn();
const voice = { voiceURI: "test-voice", name: "Test" };
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
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { speak, cancel, getVoices: () => [voice] },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  speak.mockClear();
  cancel.mockClear();
  state.auto = true;
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("does not replay old history, but speaks each new response with the selected voice", async () => {
  await act(() => render("old", "Old reply"));
  expect(speak).not.toHaveBeenCalled();
  await act(() => render("new", "New reply"));
  expect(speak).toHaveBeenCalledTimes(1);
  expect(speak.mock.calls[0]?.[0]).toMatchObject({ text: "New reply", voice });
  await act(() => render("new", "New reply"));
  expect(speak).toHaveBeenCalledTimes(1);
  await act(() => (speak.mock.calls[0]![0] as Utterance).dispatchEvent(new Event("end")));
  expect(container.textContent).toContain("Read last reply");
});
it("plays manually when automatic speech is disabled and can stop", async () => {
  state.auto = false;
  await act(() => render("old", "Old reply"));
  await act(() => render("new", "New reply"));
  expect(speak).not.toHaveBeenCalled();
  const button = container.querySelector("button")!;
  await act(() => button.click());
  expect(speak).toHaveBeenCalledTimes(1);
  expect(button.textContent).toContain("Stop voice");
  await act(() => button.click());
  expect(button.textContent).toContain("Read last reply");
});
