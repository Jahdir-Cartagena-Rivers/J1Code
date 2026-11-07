// @effect-diagnostics nodeBuiltinImport:off - Opaque view capabilities use the platform CSPRNG.
// @effect-diagnostics globalTimers:off - Native streaming capabilities own their cancellation deadline outside Effect fibers.
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";

/** A view can reach only this runtime, expires quickly, and dies with its originating J1 session. */
export class MausbotViewGrants {
  private readonly grants = new Map<
    string,
    {
      sessionId: string;
      expiresAt: number;
      sessionExpiry: number;
      abort: AbortController;
      timer: ReturnType<typeof NodeTimers.setTimeout>;
      frameOrigin: string | undefined;
    }
  >();
  private drop(key: string) {
    const grant = this.grants.get(key);
    if (!grant) return;
    this.grants.delete(key);
    NodeTimers.clearTimeout(grant.timer);
    grant.abort.abort();
  }
  issue(sessionId: string, now: number, sessionExpiry = Infinity, frameOrigin?: string) {
    if (frameOrigin !== undefined && !["t3code://app", "t3code-dev://app"].includes(frameOrigin)) {
      const url = new URL(frameOrigin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== frameOrigin)
        throw new Error("Invalid workspace host origin.");
    }
    for (const [key, grant] of this.grants) if (grant.expiresAt <= now) this.drop(key);
    const expiresAt = Math.min(now + 30 * 60_000, sessionExpiry);
    if (expiresAt <= now) throw new Error("The J1 session expired.");
    if (this.grants.size >= 32) throw new Error("Too many assistant windows are open.");
    const key = NodeCrypto.randomBytes(32).toString("hex");
    const timer = NodeTimers.setTimeout(() => this.drop(key), expiresAt - now);
    timer.unref();
    this.grants.set(key, {
      sessionId,
      expiresAt,
      sessionExpiry,
      abort: new AbortController(),
      timer,
      frameOrigin,
    });
    return `/api/mausbot/runtime/${key}/`;
  }
  valid(key: string, now: number) {
    const grant = this.grants.get(key);
    if (!grant || grant.expiresAt <= now) {
      this.drop(key);
      return false;
    }
    return true;
  }
  /** Only the original authenticated session can extend a live view without reloading its drafts. */
  renew(key: string, sessionId: string, now: number) {
    if (!this.valid(key, now)) throw new Error("This assistant window expired. Reopen it from J1.");
    const grant = this.grants.get(key)!;
    if (grant.sessionId !== sessionId)
      throw new Error("This assistant window belongs to another J1 session.");
    grant.expiresAt = Math.min(now + 30 * 60_000, grant.sessionExpiry);
    NodeTimers.clearTimeout(grant.timer);
    grant.timer = NodeTimers.setTimeout(() => this.drop(key), grant.expiresAt - now);
    grant.timer.unref();
    return `/api/mausbot/runtime/${key}/`;
  }
  revoke(sessionId: string) {
    for (const [key, grant] of this.grants) if (grant.sessionId === sessionId) this.drop(key);
  }
  signal(key: string, now: number) {
    return this.valid(key, now) ? this.grants.get(key)!.abort.signal : undefined;
  }
  frameOrigin(key: string) {
    return this.grants.get(key)?.frameOrigin;
  }
  clear() {
    for (const key of this.grants.keys()) this.drop(key);
  }
}
