import { describe, it, expect } from "@effect/vitest";
import { LivePresence, stepLabel } from "./livePresence.ts";

const setup = () => {
  let clock = 1_000;
  const sent: Array<Record<string, unknown>> = [];
  const errors: unknown[] = [];
  const presence = new LivePresence<string>(
    async (_connection, body) => {
      sent.push(body);
    },
    () => clock,
    (error) => errors.push(error),
  );
  return { presence, sent, errors, advance: (ms: number) => (clock += ms) };
};
const target = {
  connection: "hive",
  provider: "codex",
  title: "Lamp",
  project: "Studio",
  taskId: "t1",
};
const command = { type: "item.started", payload: { itemType: "command_execution" } };

describe("live chat presence", () => {
  it("announces a turn, follows steps without flooding, and marks the chat idle when done", () => {
    const { presence, sent, advance } = setup();
    presence.begin("chat-a", target);
    expect(sent[0]).toMatchObject({
      chatId: "chat-a",
      status: "working",
      taskId: "t1",
      title: "Lamp",
    });
    presence.observe("chat-a", command);
    expect(sent).toHaveLength(1); // inside the throttle window
    advance(2_000);
    presence.observe("chat-a", command);
    expect(sent.at(-1)).toMatchObject({ step: "running a command" });
    presence.observe("chat-a", command);
    expect(sent).toHaveLength(2); // repeats are silent
    presence.finish("chat-a");
    expect(sent.at(-1)).toMatchObject({ status: "idle" });
    presence.observe("chat-a", { type: "item.started", payload: { itemType: "file_change" } });
    expect(sent).toHaveLength(3); // nothing after the turn ends
  });

  it("reports waiting for the user immediately, even inside the throttle window", () => {
    const { presence, sent } = setup();
    presence.begin("chat-a", target);
    presence.observe("chat-a", { type: "request.opened" });
    expect(sent.at(-1)).toMatchObject({ status: "waiting", step: "waiting for the user" });
  });

  it("heartbeats long silent steps and ends sessions", () => {
    const { presence, sent, advance } = setup();
    presence.begin("chat-a", target);
    advance(10_000);
    presence.heartbeat();
    expect(sent).toHaveLength(1);
    advance(25_000);
    presence.heartbeat();
    expect(sent).toHaveLength(2);
    presence.end("chat-a");
    expect(sent.at(-1)).toEqual({ action: "end", chatId: "chat-a" });
    advance(60_000);
    presence.heartbeat();
    expect(sent).toHaveLength(3);
  });

  it("stops claiming work for a turn that never reports an end", () => {
    const { presence, sent, advance } = setup();
    presence.begin("chat-a", target);
    for (let i = 0; i < 60; i++) {
      advance(30_000);
      presence.heartbeat();
    }
    expect(sent.at(-1)).toEqual({ action: "end", chatId: "chat-a" });
  });

  it("never fails the turn when Hive Mind is unreachable and never leaks tool detail", async () => {
    const errors: unknown[] = [];
    const presence = new LivePresence<string>(
      async () => {
        throw new Error("down");
      },
      () => 0,
      (error) => errors.push(error),
    );
    presence.begin("chat-a", target);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    const label = stepLabel({
      type: "item.started",
      payload: { itemType: "command_execution", detail: "curl -H Authorization:secret-value" },
    });
    expect(JSON.stringify(label)).not.toContain("secret");
  });
});
