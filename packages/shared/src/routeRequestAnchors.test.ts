import { it, expect } from "vite-plus/test";
import { routeRequestAnchors } from "./routeRequestAnchors.ts";
const messages = [
  { id: "first", role: "user", createdAt: "2026-11-04T10:00:00Z", text: "First request" },
  { id: "reply", role: "assistant", createdAt: "2026-11-04T10:01:00Z" },
  { id: "second", role: "user", createdAt: "2026-11-04T11:00:00Z", text: "Next request" },
];
it("anchors to the source turn and ignores later receipts or followups", () => {
  const request = { requestId: "r" };
  const notice = {
    kind: "routing.updated",
    createdAt: "2026-11-04T10:02:00Z",
    payload: { requestId: "r" },
  };
  expect(routeRequestAnchors([request], messages, [notice]).get("r")).toBe("reply");
  expect(
    routeRequestAnchors([request], messages, [
      { ...notice, createdAt: "2026-11-04T11:02:00Z" },
      notice,
    ]).get("r"),
  ).toBe("reply");
});
it("does not attach older cards to an unrelated paginated message", () => {
  expect(
    routeRequestAnchors([{ requestId: "old" }], messages.slice(2), [
      { kind: "routing.updated", createdAt: "2026-11-04T10:02:00Z", payload: { requestId: "old" } },
    ]).size,
  ).toBe(0);
});
it("matches legacy request text and preserves records without notices", () => {
  const summary = "A historical request with enough text";
  const users = [
    ...messages,
    {
      id: "legacy",
      role: "user",
      createdAt: "2026-11-04T12:00:00Z",
      text: summary + " and constraints",
    },
  ];
  expect(routeRequestAnchors([{ requestId: "legacy", summary }], users, []).get("legacy")).toBe(
    "legacy",
  );
  expect(routeRequestAnchors([{ requestId: "unknown" }], users, []).get("unknown")).toBe("reply");
  expect(routeRequestAnchors([{ requestId: "empty" }], [], []).size).toBe(0);
});

it("does not move a card to a later followup quoting its summary", () => {
  const summary = "The forwarded implementation request";
  const later = [
    ...messages,
    { id: "quote", role: "user", createdAt: "2026-11-04T12:00:00Z", text: summary },
  ];
  expect(
    routeRequestAnchors([{ requestId: "r", summary }], later, [
      { kind: "routing.updated", createdAt: "2026-11-04T10:02:00Z", payload: { requestId: "r" } },
    ]).get("r"),
  ).toBe("reply");
});

it("places each handoff after its commentary and never moves on completion", () => {
  const history = [
    ...messages,
    { id: "handoff", role: "assistant", createdAt: "2026-11-04T10:01:30Z" },
    { id: "result", role: "assistant", createdAt: "2026-11-04T10:03:00Z" },
  ];
  const notice = {
    kind: "routing.updated",
    createdAt: "2026-11-04T10:02:00Z",
    payload: { requestId: "r" },
  };
  const completed = { ...notice, createdAt: "2026-11-04T11:30:00Z" };
  expect(routeRequestAnchors([{ requestId: "r" }], history, [completed, notice]).get("r")).toBe(
    "handoff",
  );
});

it("uses the first reply when the route precedes commentary without leaking to another turn", () => {
  const notice = {
    kind: "routing.updated",
    createdAt: "2026-11-04T10:00:30Z",
    payload: { requestId: "r" },
  };
  expect(routeRequestAnchors([{ requestId: "r" }], messages, [notice]).get("r")).toBe("reply");
  expect(
    routeRequestAnchors(
      [{ requestId: "r" }],
      messages.filter((m) => m.id !== "reply"),
      [notice],
    ).get("r"),
  ).toBe("first");
});
