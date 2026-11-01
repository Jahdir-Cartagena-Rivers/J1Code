/** Filters late native callbacks, including end/error events from a previous owner. */
export class AndroidDictationLifecycle {
  private active: number | null = null;
  begin(session: number) {
    this.active = session;
  }
  accepts(session: number) {
    return this.active === session;
  }
  end(session: number) {
    if (!this.accepts(session)) return false;
    this.active = null;
    return true;
  }
  cancel() {
    this.active = null;
  }
}
