export interface WorkspaceLifecycleClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultClock: WorkspaceLifecycleClock = {
  now: Date.now,
  setTimeout,
  clearTimeout,
};

/** Keeps native handoffs from outliving the foreground WebView that requested them. */
export class WorkspaceLifecycle {
  private foreground = true;
  private authenticated = false;
  private expiresAt: number | null = null;
  private inFlight = false;
  private generation = 0;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly handlers: {
      readonly onHandoffTimeout: () => void;
      readonly onRefreshNeeded: () => void;
    },
    private readonly clock: WorkspaceLifecycleClock = defaultClock,
  ) {}

  begin() {
    if (!this.foreground || this.inFlight) return null;
    this.inFlight = true;
    const generation = ++this.generation;
    this.clearHandoffTimer();
    this.handoffTimer = this.clock.setTimeout(() => {
      if (!this.isCurrent(generation)) return;
      this.finishHandoff();
      this.handlers.onHandoffTimeout();
    }, 65_000);
    return generation;
  }

  acceptIssue(generation: number) {
    return this.isCurrent(generation);
  }

  acceptAuthenticated(generation: number, expiresAt: string) {
    if (!this.isCurrent(generation)) return false;
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) return false;
    this.finishHandoff();
    this.authenticated = true;
    this.expiresAt = parsed;
    this.scheduleRefresh();
    return true;
  }

  acceptFailure(generation: number) {
    if (!this.isCurrent(generation)) return false;
    this.finishHandoff();
    return true;
  }

  background() {
    this.foreground = false;
    this.generation++;
    this.inFlight = false;
    this.clearHandoffTimer();
    this.clearRefreshTimer();
  }

  activate() {
    this.foreground = true;
    if (
      !this.authenticated ||
      this.expiresAt === null ||
      this.expiresAt <= this.clock.now() + 60_000
    )
      return true;
    this.scheduleRefresh();
    return false;
  }

  foregrounded() {
    return this.activate();
  }

  rejectHandoff(generation: number) {
    if (!this.acceptFailure(generation)) return false;
    this.authenticated = false;
    this.expiresAt = null;
    this.clearRefreshTimer();
    return true;
  }

  invalidate() {
    this.authenticated = false;
    this.expiresAt = null;
    this.generation++;
    this.inFlight = false;
    this.clearHandoffTimer();
    this.clearRefreshTimer();
  }

  dispose() {
    this.background();
  }

  private isCurrent(generation: number) {
    return this.foreground && this.inFlight && generation === this.generation;
  }

  private finishHandoff() {
    this.inFlight = false;
    this.clearHandoffTimer();
  }

  private scheduleRefresh() {
    this.clearRefreshTimer();
    if (!this.foreground || this.expiresAt === null) return;
    const delay = this.expiresAt - this.clock.now() - 60_000;
    if (delay <= 0) return;
    this.refreshTimer = this.clock.setTimeout(() => {
      this.refreshTimer = null;
      if (this.foreground) this.handlers.onRefreshNeeded();
    }, delay);
  }

  private clearHandoffTimer() {
    if (this.handoffTimer) this.clock.clearTimeout(this.handoffTimer);
    this.handoffTimer = null;
  }

  private clearRefreshTimer() {
    if (this.refreshTimer) this.clock.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
}
