import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { AuthAccessWriteScope, AuthOrchestrationOperateScope, AuthSessionId, AuthSettingsWriteScope, type AuthClientSession } from "@j1code/contracts";
import { MausbotViewGrants } from "./ViewGrants.ts";

const keyOf = (url: string) => url.split("/")[4]!;
describe("assistant view capabilities", () => {
  it("renews the same view for its authenticated owner without extending the J1 session", () => {
    const grants = new MausbotViewGrants();
    const url = grants.issue("owner", 0, 40 * 60_000);
    const key = keyOf(url);
    expect(() => grants.renew(key, "other", 20 * 60_000)).toThrow("another J1 session");
    expect(grants.renew(key, "owner", 20 * 60_000)).toBe(url);
    expect(grants.valid(key, 35 * 60_000)).toBe(true);
    expect(grants.valid(key, 40 * 60_000)).toBe(false);
    expect(() => grants.renew(key, "owner", 40 * 60_000)).toThrow("expired");
    grants.clear();
  });
  it("keeps paired identities separate and drops admin views on scope reduction", () => {
    const grants = new MausbotViewGrants();
    const admin = keyOf(grants.issue("owner", 0));
    const client = keyOf(grants.issue("paired", 0, Infinity, undefined, false));
    expect(grants.clientSession(admin)).toBeUndefined();
    expect(grants.clientSession(client)).toBe("paired");
    expect(() => grants.renew(client, "other-environment-session", 1)).toThrow(
      "another J1 session",
    );
    grants.revokeAdministrative("owner");
    expect(grants.valid(admin, 1)).toBe(false);
    expect(grants.valid(client, 1)).toBe(true);
    grants.revoke("paired");
    expect(grants.valid(client, 1)).toBe(false);
    grants.clear();
  });
  it("limits named settings to mobile or tablet administrative token sessions", () => {
    const grants = new MausbotViewGrants();
    const key = keyOf(grants.issue("phone", 0));
    const client = keyOf(grants.issue("phone", 0, Infinity, undefined, false));
    const session: AuthClientSession = {
      sessionId: AuthSessionId.make("phone"), subject: "fixture",
      scopes: [AuthOrchestrationOperateScope, AuthAccessWriteScope, AuthSettingsWriteScope],
      method: "bearer-access-token", client: { deviceType: "mobile" },
      issuedAt: DateTime.makeUnsafe(0), expiresAt: DateTime.makeUnsafe(1000),
      lastConnectedAt: null, connected: true, current: false,
    };
    try {
      expect(grants.authorize(key, 1, [session])).toBe(true);
      expect(grants.pairedSettingsSession(key, [session])).toBe("phone");
      const tablet = { ...session, method: "dpop-access-token", client: { deviceType: "tablet" } } as const;
      expect(grants.pairedSettingsSession(key, [tablet])).toBe("phone");
      expect(grants.pairedSettingsSession(client, [session])).toBeUndefined();
      expect(grants.clientSession(client)).toBe("phone");
      expect(grants.pairedSettingsSession(key, [{ ...session, client: { deviceType: "desktop" } }])).toBeUndefined();
      expect(grants.pairedSettingsSession(key, [{ ...session, method: "browser-session-cookie" }])).toBeUndefined();

      const narrowed = { ...session, scopes: [AuthOrchestrationOperateScope, AuthAccessWriteScope] };
      expect(grants.authorize(key, 2, [narrowed])).toBe(true);
      expect(grants.pairedSettingsSession(key, [narrowed])).toBeUndefined();
      const anotherAdmin = keyOf(grants.issue("phone", 2));
      const accessRemoved = { ...session, scopes: [AuthOrchestrationOperateScope, AuthSettingsWriteScope] };
      expect(grants.authorize(anotherAdmin, 2, [accessRemoved])).toBe(false);
      const stream = grants.signal(key, 2)!;
      expect(grants.authorize(key, 3, [])).toBe(false);
      expect(stream.aborted).toBe(true);
      expect(grants.pairedSettingsSession(key, [session])).toBeUndefined();
      expect(grants.authorize(client, 3, [narrowed])).toBe(true);
    } finally {
      grants.clear();
    }
  });

  it("binds embedding to an exact host origin and rejects policy injection", () => {
    const grants = new MausbotViewGrants();
    const key = keyOf(grants.issue("owner", 0, Infinity, "https://j1.example"));
    expect(grants.frameOrigin(key)).toBe("https://j1.example");
    expect(() => grants.issue("owner", 0, Infinity, "https://j1.example/path")).toThrow();
    expect(() => grants.issue("owner", 0, Infinity, "https://j1.example; default-src *")).toThrow();
    expect(() => grants.issue("owner", 0, Infinity, "javascript:alert(1)")).toThrow();
    grants.clear();
  });
  it("expires with the originating session and revokes only that owner's views", () => {
    const grants = new MausbotViewGrants();
    const first = keyOf(grants.issue("owner", 1000, 5000));
    const second = keyOf(grants.issue("other", 1000));
    expect(grants.valid(first, 4999)).toBe(true);
    expect(grants.valid(first, 5000)).toBe(false);
    const third = keyOf(grants.issue("owner", 2000));
    const stream = grants.signal(third, 2001)!;
    expect(stream.aborted).toBe(false);
    grants.revoke("owner");
    expect(stream.aborted).toBe(true);
    expect(grants.valid(third, 2001)).toBe(false);
    expect(grants.valid(second, 2001)).toBe(true);
    expect(grants.valid(second, 1000 + 30 * 60_000)).toBe(false);
  });
  it("bounds open views and invalidates all of them on runtime stop", () => {
    const grants = new MausbotViewGrants();
    const keys = Array.from({ length: 32 }, () => keyOf(grants.issue("owner", 0)));
    expect(new Set(keys).size).toBe(32);
    expect(() => grants.issue("owner", 1)).toThrow("Too many");
    grants.clear();
    expect(keys.some((key) => grants.valid(key, 1))).toBe(false);
    expect(() => grants.issue("owner", 10, 10)).toThrow("expired");
    expect(grants.valid("not-a-grant", 1)).toBe(false);
  });
});
