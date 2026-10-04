import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatProviderHandoff } from "./providerHandoff.ts";

const message = (role: OrchestrationMessage["role"], text: string): OrchestrationMessage => ({
  id: MessageId.make(`${role}-${text.length}`),
  role,
  text,
  turnId: null,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  streaming: false,
});

describe("provider handoff context", () => {
  it("preserves user and assistant conversation in order without internal traces", () => {
    const result = formatProviderHandoff([
      message("system", "internal status"),
      message("user", "Use the existing architecture"),
      message("reasoning", "private working notes"),
      message("assistant", "The server rejects switches"),
      message("user", "Allow switching back too"),
    ]);
    expect(result).toContain(
      "USER:\nUse the existing architecture\n\nASSISTANT:\nThe server rejects switches\n\nUSER:\nAllow switching back too",
    );
    expect(result).not.toContain("private working notes");
    expect(result).not.toContain("internal status");
  });

  it("keeps the original goal and latest constraints within the send budget", () => {
    const result = formatProviderHandoff(
      [
        message("user", "Original goal"),
        ...Array.from({ length: 30 }, () => message("assistant", "older output ".repeat(500))),
        message("user", "Latest correction"),
      ],
      4_000,
    );
    expect(result.length).toBeLessThanOrEqual(4_000);
    expect(result).toContain("Original goal");
    expect(result).toContain("Latest correction");
  });

  it("does not invent context for empty history or an exhausted budget", () => {
    expect(formatProviderHandoff([])).toBe("");
    expect(formatProviderHandoff([message("user", "previous request")], 10)).toBe("");
  });
});
