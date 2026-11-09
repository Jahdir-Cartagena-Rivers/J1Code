import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clipBotDropBox } from "./bot-drop-box.ts";

test("a clipped row offers both before and after inside the visible sidebar", () => {
  const box = clipBotDropBox({ top: 610, bottom: 660, height: 50 }, { top: 144, bottom: 622 });
  assert.deepEqual(box, { top: 610, bottom: 622, height: 12 });
  assert.ok(619 > box!.top + box!.height / 2);
  const top = clipBotDropBox({ top: 120, bottom: 170, height: 50 }, { top: 144, bottom: 622 });
  assert.deepEqual(top, { top: 144, bottom: 170, height: 26 });
  assert.ok(148 < top!.top + top!.height / 2);
});

test("fully hidden rows cannot become drop targets; complete and standalone rows keep their geometry", () => {
  const viewport = { top: 144, bottom: 622 };
  assert.equal(clipBotDropBox({ top: 622, bottom: 672, height: 50 }, viewport), null);
  assert.equal(clipBotDropBox({ top: 94, bottom: 144, height: 50 }, viewport), null);
  const row = { top: 200, bottom: 250, height: 50 };
  assert.deepEqual(clipBotDropBox(row, viewport), row);
  assert.equal(clipBotDropBox(row), row);
});
