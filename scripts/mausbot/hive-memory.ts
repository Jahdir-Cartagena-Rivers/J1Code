// J1 adapts the original local memory layer; credentials stay in the parent server.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import { memoryOverview, readMemoryDoc } from "../memory-store.ts";
import { withoutExpired, withoutSuperseded } from "../memory-entries.ts";

type Result = { available?: boolean; message?: string; indexed?: number; context?: string };
type Pending = {
  botId?: string;
  resolve: (value: Result) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, Pending>();
const errors = new Map<string, string>();
const file = NodePath.join(DATA_DIR, "j1-hive-memory.json");
const enabled = new Set<string>();
try {
  const data: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  if (
    !data ||
    typeof data !== "object" ||
    !("version" in data) ||
    data.version !== 1 ||
    !("bots" in data) ||
    !Array.isArray(data.bots) ||
    data.bots.some((id: unknown) => typeof id !== "string" || !/^[\w-]{1,128}$/.test(id))
  )
    throw new Error("Invalid J1 Hive Mind memory settings. The file was preserved.");
  for (const id of data.bots) enabled.add(id as string);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function request(input: unknown): Promise<Result> {
  if (!process.send || !process.connected)
    return Promise.reject(new Error("Open these memory settings in J1."));
  if (pending.size >= 8) return Promise.reject(new Error("Too many memory requests are open."));
  const requestId = NodeCrypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      if (process.connected) process.send?.({ type: "j1:hive-cancel", requestId });
      reject(new Error("Hive Mind recall timed out; local notes remain available."));
    }, 90_000);
    const botId =
      input && typeof input === "object" && "botId" in input && typeof input.botId === "string"
        ? input.botId
        : undefined;
    pending.set(requestId, { resolve, reject, timer, botId });
    process.send!({ type: "j1:hive-request", requestId, input }, (error: Error | null) => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new Error("J1's memory connection closed."));
    });
  });
}
process.on("message", (message: unknown) => {
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "j1:hive-result" ||
    !("requestId" in message) ||
    typeof message.requestId !== "string"
  )
    return;
  const one = pending.get(message.requestId);
  if (!one) return;
  clearTimeout(one.timer);
  pending.delete(message.requestId);
  if ("error" in message && typeof message.error === "string") one.reject(new Error(message.error));
  else one.resolve(("value" in message ? message.value : {}) as Result);
});
process.once("disconnect", () => {
  for (const one of pending.values()) {
    clearTimeout(one.timer);
    one.reject(new Error("J1's memory connection closed."));
  }
  pending.clear();
});

function documents(botId: string) {
  const overview = memoryOverview(botId);
  if (
    overview.topics.length > 127 ||
    overview.topics.reduce((bytes, topic) => bytes + topic.bytes, overview.index.bytes) >
      1024 * 1024
  )
    throw new Error(
      "These notes exceed the extended recall snapshot limit; local notes are unchanged.",
    );
  const today = new Date().toISOString().slice(0, 10);
  return ["MEMORY.md", ...overview.topics.map((topic) => topic.path)].map((path) => ({
    path,
    text: withoutSuperseded(withoutExpired(readMemoryDoc(botId, path).text, today).text),
  }));
}
export async function status(botId: string) {
  return {
    ...(await request({ action: "status" })),
    enabled: enabled.has(botId),
    ...(errors.has(botId) ? { lastError: errors.get(botId) } : {}),
  };
}
export async function select(botId: string, on: boolean, threadId: string) {
  if (on) {
    const result = await request({
      action: "recall",
      botId,
      threadId,
      query: "",
      documents: documents(botId),
    });
    writeFileAtomic(file, JSON.stringify({ version: 1, bots: [...new Set([...enabled, botId])] }));
    enabled.add(botId);
    errors.delete(botId);
    return { ...result, ...(await status(botId)) };
  }
  writeFileAtomic(
    file,
    JSON.stringify({ version: 1, bots: [...enabled].filter((id) => id !== botId) }),
  );
  enabled.delete(botId);
  for (const [requestId, one] of pending) {
    if (one.botId !== botId) continue;
    clearTimeout(one.timer);
    pending.delete(requestId);
    if (process.connected) process.send?.({ type: "j1:hive-cancel", requestId });
    one.reject(new Error("Extended recall was disabled."));
  }
  return {
    enabled: false,
    message: "Extended recall is off. Existing local notes and Hive Mind copies are preserved.",
  };
}
export async function recall(botId: string, threadId: string, query: string) {
  if (!enabled.has(botId)) return "";
  try {
    const result = await request({
      action: "recall",
      botId,
      threadId,
      query: query.slice(0, 16_000),
      documents: documents(botId),
    });
    if (!enabled.has(botId)) return "";
    errors.delete(botId);
    return result.context ?? "";
  } catch {
    if (!enabled.has(botId)) return "";
    const message =
      "Hive Mind extended recall is unavailable for this turn. Local memory still applies; notes have not been deleted.";
    errors.set(botId, message);
    return `[Memory status: ${message}]`;
  }
}
export async function sync(botId: string, threadId: string) {
  const result = await recall(botId, threadId, "");
  return result.startsWith("[Memory status:") ? { hiveWarning: result } : {};
}

/** Explicit provider tools use the host-selected shared authority, independently of local-note indexing. */
export function providerCall(input: unknown) {
  return request(input);
}
