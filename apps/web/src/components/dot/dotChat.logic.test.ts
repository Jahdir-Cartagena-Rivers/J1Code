import type { DotChatMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeDotMessages, nextDotSend } from "./dotChat.logic";

const message = (id: string, createdAt: string, status: DotChatMessage["status"] = "queued") =>
  ({
    id,
    connectionId: "c1",
    role: "user",
    text: id,
    createdAt,
    replyTo: null,
    status,
    error: null,
  }) as DotChatMessage;

describe("mergeDotMessages", () => {
  it("does not let a late send response turn an answered message back into queued", () => {
    const answered = message("z", "2026-10-02T10:00:00Z", "answered");
    expect(mergeDotMessages([answered], [message("z", answered.createdAt)])[0]?.status).toBe(
      "answered",
    );
    const tied = mergeDotMessages([answered], [message("a", answered.createdAt, "answered")]);
    expect(tied.map((m) => m.id)).toEqual(["z", "a"]);
  });
  it("dedupes by id, prefers the incoming copy, and keeps chronological order", () => {
    const merged = mergeDotMessages(
      [message("b", "2026-10-02T10:00:01Z"), message("c", "2026-10-02T10:00:02Z")],
      [message("a", "2026-10-02T10:00:00Z"), message("b", "2026-10-02T10:00:01Z", "answered")],
    );
    expect(merged.map((item) => [item.id, item.status])).toEqual([
      ["a", "queued"],
      ["b", "answered"],
      ["c", "queued"],
    ]);
  });
});

describe("nextDotSend", () => {
  it("reuses the request id only for the same text and connection", () => {
    let id = 0;
    const makeId = () => `r${++id}`;
    const first = nextDotSend(null, "c1", "hi", makeId);
    expect(nextDotSend(first, "c1", "hi", makeId)).toBe(first);
    expect(nextDotSend(first, "c1", "hi!", makeId).requestId).toBe("r2");
    expect(nextDotSend(first, "c2", "hi", makeId).requestId).toBe("r3");
  });
});
