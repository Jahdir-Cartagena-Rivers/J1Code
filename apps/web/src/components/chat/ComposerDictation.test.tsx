// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerDictation } from "./ComposerDictation";

class FakeRecognition {
  static current: FakeRecognition;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult:
    | ((event: { results: Array<Array<{ transcript: string }> & { isFinal: boolean }> }) => void)
    | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeRecognition.current = this;
  }
}
let root: Root;
let container: HTMLDivElement;
const change = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  change.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
function result(text: string, isFinal: boolean) {
  return Object.assign([{ transcript: text }], { isFinal });
}
it("shows interim words, continues after an engine pause, and inserts the final transcript on finish", async () => {
  await act(() =>
    root.render(
      <ComposerDictation
        value="Draft"
        onChange={change}
        onBusyChange={() => {}}
        disabled={false}
      />,
    ),
  );
  await act(() => button("Dictate message").click());
  const recognition = FakeRecognition.current;
  expect(recognition.continuous).toBe(true);
  expect(recognition.interimResults).toBe(true);
  await act(() =>
    recognition.onresult?.({
      results: [result("first phrase", true), result("next words", false)],
    }),
  );
  expect(container.textContent).toContain("first phrase next words");
  expect(change).not.toHaveBeenCalled();
  await act(() => recognition.onend?.());
  expect(recognition.start).toHaveBeenCalledTimes(2);
  await act(() => recognition.onresult?.({ results: [result("second phrase", true)] }));
  await act(() => button("Finish dictation").click());
  expect(recognition.stop).toHaveBeenCalledOnce();
  await act(() => recognition.onend?.());
  expect(change).toHaveBeenCalledWith("Draft first phrase second phrase");
});
it("does not insert speech when cancelled", async () => {
  await act(() =>
    root.render(
      <ComposerDictation
        value="Draft"
        onChange={change}
        onBusyChange={() => {}}
        disabled={false}
      />,
    ),
  );
  await act(() => button("Dictate message").click());
  const recognition = FakeRecognition.current;
  await act(() => recognition.onresult?.({ results: [result("private words", true)] }));
  await act(() => button("Cancel dictation").click());
  await act(() => recognition.onend?.());
  expect(change).not.toHaveBeenCalled();
});
it("appends recognized speech to edits made while listening", async () => {
  const render = (value: string) => (
    <ComposerDictation value={value} onChange={change} onBusyChange={() => {}} disabled={false} />
  );
  await act(() => root.render(render("First")));
  await act(() => button("Dictate message").click());
  const recognition = FakeRecognition.current;
  await act(() => root.render(render("First edited")));
  await act(() => recognition.onresult?.({ results: [result("spoken words", true)] }));
  await act(() => button("Finish dictation").click());
  await act(() => recognition.onend?.());
  expect(change).toHaveBeenCalledWith("First edited spoken words");
});
it("releases the browser microphone meter on cancellation", async () => {
  const stopTrack = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", {
    language: "en-US",
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      createAnalyser() {
        return { fftSize: 0, getByteTimeDomainData: vi.fn() };
      }
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      close = close;
    },
  );
  await act(() =>
    root.render(
      <ComposerDictation value="" onChange={change} onBusyChange={() => {}} disabled={false} />,
    ),
  );
  await act(async () => {
    button("Dictate message").click();
    await Promise.resolve();
  });
  expect(container.querySelector('[aria-label="Microphone level"]')).not.toBeNull();
  await act(() => button("Cancel dictation").click());
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  await act(() => FakeRecognition.current.onend?.());
});
