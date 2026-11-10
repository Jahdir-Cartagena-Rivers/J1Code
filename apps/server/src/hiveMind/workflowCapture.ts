/** Bounded source excerpts, not inferred facts or user preferences. */
export class WorkflowCapture {
  private readonly turns = new Map<string, Map<string, string>>();
  private key(thread: string, instance: string, turn: string) {
    return JSON.stringify([thread, instance, turn]);
  }
  append(
    thread: string,
    instance: string,
    turn: string,
    text: string,
    item = "stream",
    complete = false,
  ) {
    const key = this.key(thread, instance, turn);
    if (!this.turns.has(key) && this.turns.size >= 64)
      this.turns.delete(this.turns.keys().next().value!);
    const items = this.turns.get(key) ?? new Map<string, string>();
    if (!items.has(item) && items.size >= 32) items.delete(items.keys().next().value!);
    items.set(item, (complete ? text : (items.get(item) ?? "") + text).slice(-24000));
    let size = [...items.values()].reduce((n, value) => n + value.length, 0);
    for (const [id, value] of items) {
      if (size <= 24000) break;
      const remove = Math.min(value.length, size - 24000);
      items.set(id, value.slice(remove));
      size -= remove;
    }
    this.turns.set(key, items);
  }
  take(thread: string, instance: string, turn: string) {
    const key = this.key(thread, instance, turn);
    const text = [...(this.turns.get(key)?.values() ?? [])].join("\n");
    this.turns.delete(key);
    return text;
  }
  forget(thread: string, instance: string) {
    for (const key of this.turns.keys()) {
      const parts = JSON.parse(key) as string[];
      if (parts[0] === thread && parts[1] === instance) this.turns.delete(key);
    }
  }
}
export function workflowSummary(request: string, output: string, state: string, turn: string) {
  const excerpt = output.trim();
  return `Source turn: ${turn}. Provider reported ${state}. Agent evidence; source conversation remains authoritative.\nUser request excerpt: ${request.slice(0, 600)}\nReported method, corrections, result and next steps (excerpt):\n${excerpt.length > 2800 ? "[Earlier output omitted]\n" : ""}${excerpt.slice(-2800) || "No assistant output captured; consult source chat."}`.slice(
    0,
    4000,
  );
}
