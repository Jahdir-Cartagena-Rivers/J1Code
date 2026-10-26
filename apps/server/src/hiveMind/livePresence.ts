/** Reports what a running chat is doing to the selected Hive Mind so other chats can see it live. */
export interface PresenceTarget<Connection> {
  readonly connection: Connection;
  readonly provider: string;
  readonly title?: string;
  readonly project?: string;
  readonly taskId?: string;
}
type Status = "working" | "waiting" | "idle";
interface Live<Connection> {
  target: PresenceTarget<Connection>;
  status: Status;
  step: string;
  sentAt: number;
  sentStep: string;
  sentStatus: Status;
  touchedAt: number;
}
const MIN_GAP_MS = 1500;
const HEARTBEAT_MS = 30_000;
// A turn that never reports a terminal event must not look busy forever.
const STALE_MS = 30 * 60_000;

/** Step labels are categories only: tool names, commands and file paths may hold secrets. */
export function stepLabel(event: {
  type: string;
  payload?: unknown;
}): { status: Status; step: string } | null {
  const itemType = (event.payload as { itemType?: unknown } | undefined)?.itemType;
  switch (event.type) {
    case "turn.started":
      return { status: "working", step: "starting a reply" };
    case "request.opened":
    case "user-input.requested":
      return { status: "waiting", step: "waiting for the user" };
    case "request.resolved":
    case "user-input.resolved":
      return { status: "working", step: "continuing" };
    case "item.started":
      switch (itemType) {
        case "command_execution":
          return { status: "working", step: "running a command" };
        case "file_change":
          return { status: "working", step: "editing files" };
        case "mcp_tool_call":
        case "dynamic_tool_call":
          return { status: "working", step: "using a tool" };
        case "collab_agent_tool_call":
          return { status: "working", step: "coordinating sub-agents" };
        case "web_search":
          return { status: "working", step: "searching the web" };
        case "image_view":
          return { status: "working", step: "viewing an image" };
        case "reasoning":
        case "plan":
          return { status: "working", step: "thinking" };
        case "assistant_message":
          return { status: "working", step: "writing a reply" };
        default:
          return null;
      }
    default:
      return null;
  }
}

export class LivePresence<Connection> {
  private readonly live = new Map<string, Live<Connection>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly send: (
    connection: Connection,
    body: Record<string, unknown>,
  ) => Promise<unknown>;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  constructor(
    send: (connection: Connection, body: Record<string, unknown>) => Promise<unknown>,
    now: () => number = Date.now,
    onError: (error: unknown) => void = () => {},
  ) {
    this.send = send;
    this.now = now;
    this.onError = onError;
  }
  private report(chatId: string, connection: Connection, body: Record<string, unknown>) {
    // Preserve lifecycle order even when a heartbeat is still in flight at completion.
    // Each chat has its own queue so a slow connection cannot hold up other chats.
    const send = () => this.send(connection, body).catch(this.onError);
    const previous = this.pending.get(chatId);
    const next = previous ? previous.then(send) : send();
    this.pending.set(chatId, next);
    void next.then(() => {
      if (this.pending.get(chatId) === next) this.pending.delete(chatId);
    });
  }
  private push(chatId: string, entry: Live<Connection>) {
    entry.sentAt = this.now();
    entry.sentStep = entry.step;
    entry.sentStatus = entry.status;
    const { target } = entry;
    this.report(chatId, target.connection, {
      chatId,
      provider: target.provider,
      status: entry.status,
      step: entry.step,
      ...(target.title ? { title: target.title } : {}),
      ...(target.project ? { project: target.project } : {}),
      ...(target.taskId ? { taskId: target.taskId } : {}),
    });
  }
  /** A turn was accepted for this chat. */
  begin(chatId: string, target: PresenceTarget<Connection>) {
    const entry: Live<Connection> = {
      target,
      status: "working",
      step: "starting a reply",
      sentAt: 0,
      sentStep: "",
      sentStatus: "idle",
      touchedAt: this.now(),
    };
    this.live.set(chatId, entry);
    this.push(chatId, entry);
  }
  /** Runtime events update the step; bursts are throttled and repeats are silent. */
  observe(chatId: string, event: { type: string; payload?: unknown }) {
    const entry = this.live.get(chatId);
    const next = entry && stepLabel(event);
    if (!entry || !next) return;
    entry.touchedAt = this.now();
    entry.status = next.status;
    entry.step = next.step;
    const changed = entry.step !== entry.sentStep || entry.status !== entry.sentStatus;
    // A status change (e.g. waiting for the user) is never throttled away.
    if (changed && (entry.status !== entry.sentStatus || this.now() - entry.sentAt >= MIN_GAP_MS))
      this.push(chatId, entry);
  }
  /** The turn ended: leave a visible idle marker so others see the chat as finished. */
  finish(chatId: string) {
    const entry = this.live.get(chatId);
    if (!entry) return;
    this.live.delete(chatId);
    entry.status = "idle";
    entry.step = "finished its last turn";
    this.push(chatId, entry);
  }
  /** The session is gone: drop the entry entirely. */
  end(chatId: string) {
    const entry = this.live.get(chatId);
    if (!entry) return;
    this.live.delete(chatId);
    this.report(chatId, entry.target.connection, { action: "end", chatId });
  }
  /** Keeps long silent steps from expiring; call about every 30 seconds. */
  heartbeat() {
    for (const [chatId, entry] of [...this.live]) {
      if (this.now() - entry.touchedAt >= STALE_MS) this.end(chatId);
      else if (this.now() - entry.sentAt >= HEARTBEAT_MS) this.push(chatId, entry);
    }
  }
  /** Wait for reports already accepted by this reporter, without delaying provider turns. */
  async flush() {
    while (this.pending.size > 0) await Promise.all(this.pending.values());
  }
}
