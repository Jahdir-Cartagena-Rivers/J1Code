// @vitest-environment jsdom
import { expect, it, vi } from "vite-plus/test";
import { buildBotBrowserDocument } from "./browserDocument.ts";
import { readBotBrowserEvent } from "./browserEvent.ts";
it("forwards page controls without replaying website scripts or handlers", () => {
  const html = buildBotBrowserDocument({
    revision: "abc",
    url: "https://site.test/form",
    title: "Test",
    html: '<html><head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test"></head><body><script>evil()</script><button data-j1-browser-node="0" onclick="evil()" nonce="abc">Apply</button><input data-j1-browser-node="1"></body></html>',
  });
  const doc = new DOMParser().parseFromString(html, "text/html");
  const postMessage = vi.fn();
  const scripts = [...doc.querySelectorAll("script")];
  expect(scripts).toHaveLength(1);
  expect(scripts[0]!.getAttribute("nonce")).toBe("j1abc");
  expect(doc.querySelector("meta")!.content).toContain("script-src 'nonce-j1abc'");
  expect(doc.querySelector("button")?.getAttribute("onclick")).toBeNull();
  expect(doc.querySelector("base")?.href).toBe("https://site.test/form");
  Function(
    "document",
    "window",
    "Element",
    scripts[0]!.textContent!,
  )(doc, { parent: { postMessage } }, Element);
  doc
    .querySelector("button")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const event = postMessage.mock.calls[0]![0];
  expect(readBotBrowserEvent(event, "abc")).toEqual({ type: "click", revision: "abc", node: 0 });
  expect(readBotBrowserEvent(event, "stale")).toBeNull();
  const input = doc.querySelector("input")!;
  input.value = "hello";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  doc
    .querySelector("button")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(readBotBrowserEvent(postMessage.mock.calls[1]![0], "abc")).toEqual({
    type: "click",
    revision: "abc",
    node: 0,
    edits: [{ node: 1, value: "hello" }],
  });
  expect(
    readBotBrowserEvent(
      {
        type: "j1-bot-browser",
        revision: "abc",
        action: { type: "navigate", url: "file:///secret" },
      },
      "abc",
    ),
  ).toBeNull();
});
