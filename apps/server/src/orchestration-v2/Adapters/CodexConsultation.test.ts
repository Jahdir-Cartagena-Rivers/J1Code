import * as NodeAssert from "node:assert/strict";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Build the native child's attestation independently.
import * as NodeCrypto from "node:crypto";

import { it } from "@effect/vitest";

import {
  CODEX_CONSULTATION_PROTOCOL,
  startIsolatedCodexConsultation,
  type CodexConsultationAttestation,
  type CodexConsultationChild,
  type CodexConsultationClaim,
  type CodexConsultationProcessFactory,
} from "./CodexConsultation.ts";

function fixture() {
  const controller = new AbortController();
  const writes: string[] = [];
  let current = true;
  let closed = 0;
  let released = false;
  let onBeforeWrite = (_operation: string) => {};
  let alterProof = (proof: CodexConsultationAttestation) => proof;
  const digest = (value: unknown) =>
    NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const claim: CodexConsultationClaim = {
    providerInstanceId: "codex-instance",
    providerSessionId: "source-session",
    accountRevision: "account-revision",
    sourceItemId: "source-reply",
    history: [{ itemId: "source-reply", role: "assistant", text: "Original answer" }],
    prompt: "Review the answer",
    model: "codex-model",
    signal: controller.signal,
    isCurrent: async () => current,
  };
  const factory: CodexConsultationProcessFactory = {
    protocol: CODEX_CONSULTATION_PROTOCOL,
    async withEmptyRoot(run) {
      try {
        return await run(process.cwd());
      } finally {
        released = true;
      }
    },
    async spawn(plan) {
      const processId = "isolated-child";
      let state: Pick<
        CodexConsultationAttestation,
        "authorization" | "nativeThreadId" | "nativeTurnId" | "model" | "historyDigest"
      > = {
        authorization: null,
        nativeThreadId: null,
        nativeTurnId: null,
        model: null,
        historyDigest: null,
      };
      async function write(operation: string, authorize: () => Promise<boolean>) {
        onBeforeWrite(operation);
        if (!(await authorize())) throw new Error("Native write rejected");
        writes.push(operation);
      }
      return {
        processId,
        async attest() {
          return alterProof({
            ...state,
            protocol: CODEX_CONSULTATION_PROTOCOL,
            nonce: plan.nonce,
            processId,
            launchDigest: plan.digest,
            configSources: ["consultation-launch"],
            actionTools: [],
            mcpServers: [],
            hooks: [],
            plugins: [],
            apps: [],
            sandbox: "read-only",
            approval: "never",
          });
        },
        async bindAccount(input) {
          await write("bind", input.authorize);
          state = {
            ...state,
            authorization: digest([
              input.providerInstanceId,
              input.providerSessionId,
              input.accountRevision,
            ]),
          };
        },
        async createThread(input) {
          await write("thread", input.authorize);
          state = { ...state, nativeThreadId: "child-thread", model: input.model };
          return "child-thread";
        },
        async injectHistory(input) {
          await write("history", input.authorize);
          state = { ...state, historyDigest: digest(input.history) };
        },
        async start(input) {
          await write("start", input.authorize);
          state = { ...state, nativeTurnId: "child-turn" };
          return "child-turn";
        },
        async close() {
          closed += 1;
        },
      } satisfies CodexConsultationChild;
    },
  };
  return {
    writes,
    controller,
    changeProof: (alter: typeof alterProof) => {
      alterProof = alter;
    },
    expireBefore: (target: string) => {
      onBeforeWrite = (operation) => {
        if (operation === target) current = false;
      };
    },
    verifyCleanup: () => {
      NodeAssert.equal(closed, 1);
      NodeAssert.equal(released, true);
    },
    run: (receive: Parameters<typeof startIsolatedCodexConsultation<string>>[3]) =>
      startIsolatedCodexConsultation(factory, process.execPath, claim, receive),
  };
}

it("receives the attested child turn and releases the owned process", async () => {
  const child = fixture();
  NodeAssert.equal(
    await child.run(async (turn) => {
      NodeAssert.deepEqual(turn, { nativeThreadId: "child-thread", nativeTurnId: "child-turn" });
      return "result";
    }),
    "result",
  );
  NodeAssert.deepEqual(child.writes, ["bind", "thread", "history", "start"]);
  child.verifyCleanup();
});

it("rejects unexpected config before binding an account", async () => {
  const child = fixture();
  child.changeProof((proof) => ({ ...proof, configSources: ["untrusted-config"] }));
  await NodeAssert.rejects(
    child.run(async () => NodeAssert.fail("Unexpected result handler")),
    /attest/,
  );
  NodeAssert.deepEqual(child.writes, []);
  child.verifyCleanup();
});

it("rejects an unexpected child account before creating the thread", async () => {
  const child = fixture();
  child.changeProof((proof) =>
    proof.authorization === null ? proof : { ...proof, authorization: "different-account" },
  );
  await NodeAssert.rejects(
    child.run(async () => NodeAssert.fail("Unexpected result handler")),
    /attest/,
  );
  NodeAssert.deepEqual(child.writes, ["bind"]);
  child.verifyCleanup();
});

it("rejects a different loaded history before starting the turn", async () => {
  const child = fixture();
  child.changeProof((proof) =>
    proof.historyDigest === null ? proof : { ...proof, historyDigest: "different-history" },
  );
  await NodeAssert.rejects(
    child.run(async () => NodeAssert.fail("Unexpected result handler")),
    /attest/,
  );
  NodeAssert.deepEqual(child.writes, ["bind", "thread", "history"]);
  child.verifyCleanup();
});

it("rejects action tools reported by the child before binding an account", async () => {
  const child = fixture();
  child.changeProof((proof) => ({ ...proof, actionTools: ["shell"] }));
  await NodeAssert.rejects(
    child.run(async () => NodeAssert.fail("Unexpected result handler")),
    /attest/,
  );
  NodeAssert.deepEqual(child.writes, []);
  child.verifyCleanup();
});

it("rejects native start if the claim expires at the write boundary", async () => {
  const child = fixture();
  child.expireBefore("start");
  await NodeAssert.rejects(
    child.run(async () => NodeAssert.fail("Unexpected result handler")),
    /write rejected/,
  );
  NodeAssert.deepEqual(child.writes, ["bind", "thread", "history"]);
  child.verifyCleanup();
});

it("cancels and releases the child even if the result consumer never settles", async () => {
  const child = fixture();
  const reason = new Error("Consultation cancelled");
  const result = child.run(async () => {
    child.controller.abort(reason);
    return new Promise<string>(() => {});
  });
  const deadline = AbortSignal.timeout(1_000);
  const stalled = Promise.withResolvers<never>();
  const expire = () => stalled.reject(new Error("Cancellation did not settle"));
  deadline.addEventListener("abort", expire, { once: true });
  try {
    await NodeAssert.rejects(Promise.race([result, stalled.promise]), /Consultation cancelled/);
  } finally {
    deadline.removeEventListener("abort", expire);
  }
  child.verifyCleanup();
});
