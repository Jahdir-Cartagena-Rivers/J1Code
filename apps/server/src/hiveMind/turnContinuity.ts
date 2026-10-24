/** Correlate memory with accepted native turns, including terminal events arriving before admission returns. */
export class TurnContinuity<Memory, Outcome extends { readonly type: string }> {
  private readonly active = new Map<string, Memory>();
  private readonly pending = new Map<string, Set<symbol>>();
  private readonly early = new Map<string, Outcome[]>();
  private prefix(thread: string, instance: string) {
    return `${encodeURIComponent(thread)}|${encodeURIComponent(instance)}|`;
  }
  private key(thread: string, instance: string, turn: string) {
    return this.prefix(thread, instance) + encodeURIComponent(turn);
  }
  begin(thread: string, instance: string) {
    const prefix = this.prefix(thread, instance);
    const tokens = this.pending.get(prefix) ?? new Set<symbol>();
    const token = Symbol();
    tokens.add(token);
    this.pending.set(prefix, tokens);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (this.pending.get(prefix) !== tokens) return;
      tokens.delete(token);
      if (!tokens.size) {
        this.pending.delete(prefix);
        for (const key of this.early.keys()) if (key.startsWith(prefix)) this.early.delete(key);
      }
    };
  }
  accept(thread: string, instance: string, turn: string, memory: Memory) {
    const key = this.key(thread, instance, turn);
    this.active.set(key, memory);
    const outcomes = this.early.get(key) ?? [];
    this.early.delete(key);
    if (outcomes.some((o) => o.type !== "runtime.error")) this.active.delete(key);
    return outcomes.map((outcome) => ({ memory, outcome }));
  }
  receive(thread: string, instance: string, turn: string, outcome: Outcome) {
    const key = this.key(thread, instance, turn);
    const memory = this.active.get(key);
    if (memory !== undefined) {
      if (outcome.type !== "runtime.error") this.active.delete(key);
      return [{ memory, outcome }];
    }
    if (this.pending.has(this.prefix(thread, instance))) {
      const outcomes = this.early.get(key) ?? [];
      this.early.set(key, [...outcomes, outcome].slice(-16));
    }
    return [];
  }
  forget(thread: string, instance: string) {
    const prefix = this.prefix(thread, instance);
    this.pending.delete(prefix);
    for (const collection of [this.active, this.early])
      for (const key of collection.keys()) if (key.startsWith(prefix)) collection.delete(key);
  }
}
