import { assert, beforeEach, it, vi } from "vite-plus/test";

const { byPid, list, on, postMessage } = vi.hoisted(() => ({
  byPid: vi.fn(),
  list: vi.fn(),
  on: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({ parentPort: { on, postMessage } }));
vi.mock("@crowecawcaw/xa11y", () => ({ App: { byPid, list } }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

it.each(["lookup", "children"])("falls back to enumeration after a failed %s", async (failure) => {
  const error = new Error("Unavailable");
  if (failure === "lookup") byPid.mockRejectedValue(error);
  else byPid.mockResolvedValue({ children: () => Promise.reject(error) });
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const focus = vi.fn().mockResolvedValue(undefined);
  list.mockResolvedValue([{ pid: 42, asElement: () => ({ name: "J1 Code", bounds, focus }) }]);
  await import("./WindowsForegroundFocusWorker.ts");
  await vi.dynamicImportSettled();
  const result = Promise.withResolvers<unknown>();
  postMessage.mockImplementation(result.resolve);
  on.mock.calls[0]![1]({
    type: "focus",
    requestId: 1,
    target: { windowId: 1, processId: 42, title: "J1 Code", bounds, contentBounds: bounds },
  });
  assert.deepEqual(await result.promise, { type: "result", requestId: 1, focused: true });
  assert.lengthOf(focus.mock.calls, 1);
});


it.each([
  { name: "wrong title", title: "Another app", delta: 0, expected: false },
  { name: "outside tolerance", title: "J1 Code", delta: 3, expected: false },
  { name: "within physical-pixel tolerance", title: "J1 Code", delta: 2, expected: true },
])("matches only the intended native window: $name", async ({ title, delta, expected }) => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const focus = vi.fn().mockResolvedValue(undefined);
  byPid.mockResolvedValue({ children: async () => [{ name: title, bounds: { ...bounds, x: delta }, focus }] });
  list.mockResolvedValue([]);
  await import("./WindowsForegroundFocusWorker.ts");
  await vi.dynamicImportSettled();
  const result = Promise.withResolvers<unknown>();
  postMessage.mockImplementation(result.resolve);
  on.mock.calls[0]![1]({ type: "focus", requestId: 2,
    target: { windowId: 1, processId: 42, title: "J1 Code", bounds, contentBounds: bounds } });
  assert.deepEqual(await result.promise, { type: "result", requestId: 2, focused: expected });
  assert.lengthOf(focus.mock.calls, expected ? 1 : 0);
});

it("rejects a matching-looking window owned by another process during enumeration fallback", async () => {
  byPid.mockRejectedValue(new Error("Direct lookup unavailable"));
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const focus = vi.fn().mockResolvedValue(undefined);
  list.mockResolvedValue([{ pid: 43, asElement: () => ({ name: "J1 Code", bounds, focus }) }]);
  await import("./WindowsForegroundFocusWorker.ts");
  await vi.dynamicImportSettled();
  const result = Promise.withResolvers<unknown>();
  postMessage.mockImplementation(result.resolve);
  on.mock.calls[0]![1]({ type: "focus", requestId: 3,
    target: { windowId: 1, processId: 42, title: "J1 Code", bounds, contentBounds: bounds } });
  assert.deepEqual(await result.promise, { type: "result", requestId: 3, focused: false });
  assert.lengthOf(list.mock.calls, 1);
  assert.lengthOf(focus.mock.calls, 0);
});
