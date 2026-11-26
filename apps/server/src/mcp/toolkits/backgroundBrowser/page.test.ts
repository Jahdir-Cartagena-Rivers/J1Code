// @vitest-environment jsdom
import { afterEach, expect, it } from "vite-plus/test";
import { browserPageScript, browserActionScript } from "./page.ts";
import { BotBrowserPage } from "@j1code/contracts";
import { Schema } from "effect";
interface FixtureElement {
  value: string;
  textContent: string | null;
  addEventListener(type: string, callback: () => void): void;
  remove(): void;
}
const browser = globalThis as unknown as {
  eval(script: string): unknown;
  history: { replaceState(data: unknown, unused: string, url: string): void };
  location: { href: string };
  document: { body: { innerHTML: string }; querySelector(selector: string): FixtureElement | null };
};
const evaluate = (script: string) => browser.eval(script);
const decodePage = Schema.decodeUnknownSync(BotBrowserPage);
const snapshot = (revision: string, known?: string) =>
  decodePage(evaluate(browserPageScript(revision, known)));
afterEach(() => {
  browser.document.body.innerHTML = "";
  Reflect.deleteProperty(globalThis, "__j1BrowserView");
});
it("views and changes the original DOM, masks secrets, and rejects stale controls", () => {
  browser.document.body.innerHTML =
    '<h1 id="out">Initial</h1><input id="entry" value="before"><button id="apply">Apply</button><input type="password" value="secret"><input type="hidden" value="token">';
  browser.document.querySelector("#apply")?.addEventListener("click", () => {
    browser.document.querySelector("#out")!.textContent = (
      browser.document.querySelector("#entry") as FixtureElement
    ).value;
  });
  const first = snapshot("first");
  expect(first.html).not.toContain("secret");
  expect(first.html).not.toContain("token");
  expect((browser.document.querySelector("input[type=password]") as FixtureElement).value).toBe(
    "secret",
  );
  evaluate(
    browserActionScript({ type: "fill", revision: first.revision, node: 0, value: "after" }),
  );
  const second = snapshot("second");
  expect(() =>
    evaluate(browserActionScript({ type: "click", revision: first.revision, node: 1 })),
  ).toThrow("Page changed");
  evaluate(browserActionScript({ type: "click", revision: second.revision, node: 1 }));
  expect(browser.document.querySelector("#out")?.textContent).toBe("after");
  browser.document.querySelector("#apply")?.remove();
  expect(() =>
    evaluate(browserActionScript({ type: "click", revision: second.revision, node: 1 })),
  ).toThrow("Page changed");
});
it("applies edits and the submit click together without losing the click to a refresh", () => {
  browser.document.body.innerHTML =
    '<input id="entry" value="before"><button id="submit">Submit</button><p id="out"></p>';
  browser.document.querySelector("#submit")!.addEventListener("click", () => {
    browser.document.querySelector("#out")!.textContent = (
      browser.document.querySelector("#entry") as FixtureElement
    ).value;
  });
  const page = snapshot("batch");
  evaluate(
    browserActionScript({
      type: "click",
      revision: page.revision,
      node: 1,
      edits: [{ node: 0, value: "submitted" }],
    }),
  );
  expect(browser.document.querySelector("#out")!.textContent).toBe("submitted");
});
it("keeps a revision stable while the document and controls remain unchanged", () => {
  browser.document.body.innerHTML = "<button>Apply</button>";
  const first = snapshot("first");
  expect(snapshot("second").revision).toBe(first.revision);
  expect(snapshot("third", first.revision).html).toBe("");
});

it("rejects old controls after same-document navigation until the view is refreshed", () => {
  const originalUrl = browser.location.href;
  browser.document.body.innerHTML = '<input value="before"><button>Apply</button>';
  const input = browser.document.querySelector("input")!;
  let clicks = 0;
  browser.document.querySelector("button")!.addEventListener("click", () => clicks++);

  try {
    const first = snapshot("before-navigation");
    const action = {
      type: "click" as const,
      revision: first.revision,
      node: 1,
      edits: [{ node: 0, value: "after" }],
    };
    browser.history.replaceState(null, "", "#new-view");

    expect(() => evaluate(browserActionScript(action))).toThrow("Page changed");
    expect(input.value).toBe("before");
    expect(clicks).toBe(0);

    const current = snapshot("after-navigation");
    expect(current.revision).not.toBe(first.revision);
    evaluate(browserActionScript({ ...action, revision: current.revision }));
    expect(input.value).toBe("after");
    expect(clicks).toBe(1);
  } finally {
    browser.history.replaceState(null, "", originalUrl);
  }
});
