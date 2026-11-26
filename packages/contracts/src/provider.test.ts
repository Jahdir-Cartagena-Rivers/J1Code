import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ProviderSession, ProviderSessionStartInput, ProviderSendTurnInput, ProviderUploadFeedbackInput, ProviderUploadFeedbackResult, ProviderUploadFeedbackError } from "./provider.ts";

const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSendTurnInput", () => {
  it.each(["image", "file"])(
    "caps total image bytes for %s attachments without charging videos",
    (type) => {
      const image = {
        type,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
      };
      const video = {
        type: "file",
        id: "video",
        name: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50 * 1024 * 1024,
      };
      expect(
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), video],
        }).attachments,
      ).toHaveLength(9);
      expect(() =>
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), { ...image, sizeBytes: 1 }],
        }),
      ).toThrow(/80 MiB/);
    },
  );
});

describe("provider feedback", () => {
  it("keeps the failed thread and original cause without exposing upstream text", () => {
    const cause = new Error("provider request secret");
    const error = new ProviderUploadFeedbackError({
      threadId: ThreadId.make("thread-1"),
      cause,
    });

    expect(error.threadId).toBe("thread-1");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Failed to upload feedback for thread thread-1.");
    expect(error.message).not.toContain("provider request secret");
  });
});


const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSession = Schema.decodeUnknownSync(ProviderSession);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      runtimeMode: "full-access",
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelSelection?.instanceId).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    expect(getOptionValue(parsed.modelSelection?.options, "reasoningEffort")).toBe("high");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts claude runtime knobs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [
          { id: "thinking", value: true },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ],
      },
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.instanceId).toBe("claudeAgent");
    expect(parsed.modelSelection?.model).toBe("claude-sonnet-4-6");
    expect(getOptionValue(parsed.modelSelection?.options, "thinking")).toBe(true);
    expect(getOptionValue(parsed.modelSelection?.options, "effort")).toBe("max");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
    expect(parsed.runtimeMode).toBe("full-access");
  });

  it("accepts cursor provider", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "cursor",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        provider: "cursor",
        model: "composer-2",
        options: [{ id: "fastMode", value: true }],
      },
    });
    expect(parsed.provider).toBe("cursor");
    expect(parsed.modelSelection?.instanceId).toBe("cursor");
    expect(parsed.modelSelection?.model).toBe("composer-2");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: "ollama_local",
        model: "llama3.3",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
    expect(parsed.modelSelection?.instanceId).toBe("ollama_local");
  });
});


describe("providerInstanceId routing key (slice-2 invariant)", () => {
  it("decodes a ProviderSessionStartInput without providerInstanceId (legacy producer)", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      runtimeMode: "full-access",
    });
    expect(parsed.providerInstanceId).toBeUndefined();
  });

  it("decodes a ProviderSessionStartInput with providerInstanceId (post-migration producer)", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      providerInstanceId: "codex_personal",
      runtimeMode: "full-access",
    });
    expect(parsed.providerInstanceId).toBe("codex_personal");
  });

  it("propagates providerInstanceId through ProviderSession decode", () => {
    const session = decodeProviderSession({
      provider: "codex",
      providerInstanceId: "codex_work",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "thread-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(session.providerInstanceId).toBe("codex_work");
  });

  it("decodes ProviderSession for fork-provided driver kinds", () => {
    const session = decodeProviderSession({
      provider: "ollama",
      providerInstanceId: "ollama_local",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "thread-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    expect(session.provider).toBe("ollama");
    expect(session.providerInstanceId).toBe("ollama_local");
  });


  it("rejects providerInstanceId values that fail the slug pattern (defense in depth)", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerInstanceId: "1bad",
        runtimeMode: "full-access",
      }),
    ).toThrow();
  });
});

  it("accepts 100 attachments and rejects 101", () => {
    const attachments = Array.from({ length: 100 }, (_, index) => ({
      type: "image",
      id: `image-${index}`,
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 1,
    }));
    expect(
      decodeProviderSendTurnInput({ threadId: "thread-1", attachments }).attachments,
    ).toHaveLength(100);
    expect(() =>
      decodeProviderSendTurnInput({
        threadId: "thread-1",
        attachments: [...attachments, attachments[0]],
      }),
    ).toThrow();
  });

  it("accepts codex modelSelection", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "fastMode", value: true },
        ],
      },
    });

    expect(parsed.modelSelection?.instanceId).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    expect(getOptionValue(parsed.modelSelection?.options, "reasoningEffort")).toBe("xhigh");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("accepts claude modelSelection including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [
          { id: "effort", value: "ultrathink" },
          { id: "fastMode", value: true },
        ],
      },
    });

    expect(parsed.modelSelection?.instanceId).toBe("claudeAgent");
    expect(getOptionValue(parsed.modelSelection?.options, "effort")).toBe("ultrathink");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });


describe("native-session reset and same-turn metadata", () => {
  it("keeps the native reset flag separate from context clearing", () => {
    const input = { threadId: "thread-1", runtimeMode: "full-access", freshSession: true, resumeCursor: { native: "old" } };
    const decoded = decodeProviderSessionStartInput(input);
    expect(decoded.freshSession).toBe(true);
    expect(decoded.resumeCursor).toEqual(input.resumeCursor);
    expect(decoded).not.toHaveProperty("freshContext");
    const contextOnly = decodeProviderSessionStartInput({ threadId: "thread-1", runtimeMode: "full-access", freshContext: true });
    expect(contextOnly).not.toHaveProperty("freshSession");
    expect(() => decodeProviderSessionStartInput({ ...input, freshSession: "true" })).toThrow();
    expect(input.resumeCursor).toEqual({ native: "old" });
  });

  it.each([null, false, {}, { turnId: "turn-1" }, { turnId: "", runtimeMode: "full-access" }, { turnId: "turn-1", runtimeMode: "admin" }])(
    "rejects malformed same-turn metadata %j", (steer) => {
      expect(() => decodeProviderSendTurnInput({ threadId: "thread-1", input: "Continue", steer })).toThrow();
    },
  );

  it("carries exact turn and mode without inferring a new turn or resetting the session", () => {
    const input = { threadId: "thread-1", input: "Follow up", steer: { turnId: "turn-1", runtimeMode: "full-access" } };
    expect(decodeProviderSendTurnInput(input)).toEqual(input);
    const neighbor = decodeProviderSendTurnInput({ threadId: "thread-2", input: "Ordinary turn" });
    expect(neighbor).not.toHaveProperty("steer");
    expect(decodeProviderSendTurnInput(input)).not.toHaveProperty("continuation");
    expect(decodeProviderSendTurnInput(input)).not.toHaveProperty("freshSession");
  });
});

describe("current send-turn and feedback compatibility", () => {
  const image = { type: "image", id: "jpeg", name: "photo.jpeg", mimeType: "image/jpeg", sizeBytes: 1024 };

  it("accepts JPEG while rejecting malformed or oversized attachment payloads", () => {
    expect(decodeProviderSendTurnInput({ threadId: "thread-1", attachments: [image] }).attachments).toEqual([image]);
    for (const attachment of [
      { ...image, mimeType: "text/plain" },
      { ...image, sizeBytes: -1 },
      { ...image, sizeBytes: 10 * 1024 * 1024 + 1 },
      { ...image, type: "file", sizeBytes: 50 * 1024 * 1024 + 1 },
    ]) expect(() => decodeProviderSendTurnInput({ threadId: "thread-1", attachments: [attachment] })).toThrow();
    expect(() => decodeProviderSendTurnInput({ threadId: "thread-1", input: "x".repeat(120001) })).toThrow();
  });

  it("uses current model option normalization without changing the legacy session boundary", () => {
    const modelSelection = { instanceId: "custom_fork", model: "auto", options: null };
    expect(decodeProviderSendTurnInput({ threadId: "thread-1", modelSelection }).modelSelection).toEqual({ instanceId: "custom_fork", model: "auto" });
    expect(() => decodeProviderSessionStartInput({ threadId: "thread-1", runtimeMode: "full-access", modelSelection })).toThrow();
  });

  it("retains feedback input and shareable feedback result validation", () => {
    const decodeInput = Schema.decodeUnknownSync(ProviderUploadFeedbackInput);
    const decodeResult = Schema.decodeUnknownSync(ProviderUploadFeedbackResult);
    expect(decodeInput({ threadId: "thread-1", reason: "Report" })).toEqual({ threadId: "thread-1", reason: "Report" });
    expect(decodeInput({ threadId: "thread-1" })).not.toHaveProperty("reason");
    expect(decodeResult({ feedbackId: "report-1" })).toEqual({ feedbackId: "report-1" });
    expect(() => decodeResult({ feedbackId: "" })).toThrow();
    expect(() => decodeInput({ threadId: "" })).toThrow();
  });
});
