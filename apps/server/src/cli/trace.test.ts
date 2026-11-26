import { assert, it } from "@effect/vitest";

import { formatTraceSummary, makeTraceSpanSummary } from "./trace.ts";

const MINUTE_MS = 60_000;

function span(name: string, durationMs: number, endMs: number, exitTag = "Success") {
  return JSON.stringify({
    type: "effect-span",
    name,
    traceId: "trace",
    spanId: "span",
    durationMs,
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    exit: { _tag: exitTag, cause: "cause" },
  });
}

function browserSpan(
  name: string,
  status: { code: string; message?: string },
  attributes: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: "otlp-span",
    name,
    durationMs: 1,
    endTimeUnixNano: "1000000",
    status,
    attributes,
  });
}

it("drops spans that ended before the window and counts unreadable lines", () => {
  const summarizer = makeTraceSpanSummary(MINUTE_MS);
  [
    span("old", 1, 0),
    "",
    "{not json",
    JSON.stringify({ name: "no-duration" }),
    JSON.stringify({ name: "far-future", durationMs: 1, endTimeUnixNano: "9".repeat(22) }),
    span("recent", 4, 5 * MINUTE_MS),
  ].forEach(summarizer.addLine);
  const summary = summarizer.finish();

  assert.strictEqual(summary.skippedLineCount, 3);
  assert.deepStrictEqual(
    summary.spans.map((entry) => [entry.name, entry.count, entry.perMinute]),
    [["recent", 1, undefined]],
  );
});

it("reads failures and interrupts of browser spans from their OTLP status", () => {
  const summarizer = makeTraceSpanSummary();
  [
    browserSpan("render", { code: "2", message: "boom" }),
    browserSpan("render", { code: "0" }, { "effect.fiber.interrupted": true }),
    browserSpan("render", { code: "1", message: "Interrupted" }),
    browserSpan("render", { code: "1" }),
  ].forEach(summarizer.addLine);

  const [render] = summarizer.finish().spans;
  assert.deepStrictEqual([render?.count, render?.interrupted, render?.failures], [4, 2, 1]);
});

it("prints durations that round up to a second in seconds", () => {
  const summarizer = makeTraceSpanSummary();
  [span("rpc", 999.4, MINUTE_MS), span("rpc", 999.6, 2 * MINUTE_MS)].forEach(summarizer.addLine);

  const row = formatTraceSummary(summarizer.finish(), 25)
    .split("\n")
    .find((line) => line.startsWith("rpc"));
  assert.deepStrictEqual(row?.trim().split(/\s+/).slice(3, 6), ["999ms", "1s", "1s"]);
});

it("summarizes failed spans without including attributes, status messages or exit causes", () => {
  const summarizer = makeTraceSpanSummary();
  const privatePath = "/home/fixture-user/.j1/userdata";
  const credential = "fixture-credential";
  summarizer.addLine(
    browserSpan("rpc.request", { code: "2", message: privatePath }, { token: credential }),
  );
  summarizer.addLine(
    JSON.stringify({
      name: "rpc.request",
      durationMs: 5,
      endTimeUnixNano: "2000000",
      exit: { _tag: "Failure", cause: `${credential} at ${privatePath}` },
    }),
  );
  const summary = summarizer.finish();
  assert.equal(summary.spans[0]?.failures, 2);
  const report = formatTraceSummary(summary, 25);
  assert.include(report, "rpc.request");
  assert.notInclude(report, privatePath);
  assert.notInclude(report, credential);
});

it("reports an empty window without printing the contents of skipped lines", () => {
  const summarizer = makeTraceSpanSummary(MINUTE_MS);
  summarizer.addLine("incomplete private fixture");
  const report = formatTraceSummary(summarizer.finish(), 25, true);
  assert.include(report, "No spans found in the local trace file or its rotated files in that window.");
  assert.include(report, "Skipped 1 lines");
  assert.notInclude(report, "incomplete private fixture");
});
