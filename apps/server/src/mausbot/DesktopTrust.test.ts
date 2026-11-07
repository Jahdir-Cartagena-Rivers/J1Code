import { describe, expect, it } from "vite-plus/test";
import { isMausbotDesktopSession } from "./DesktopTrust.ts";

describe("native approval trust", () => {
  it("accepts the private desktop bootstrap identity", () => {
    expect(
      isMausbotDesktopSession("desktop", {
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      }),
    ).toBe(true);
  });
  it("does not promote an owner browser, remote bearer or development web server", () => {
    expect(
      isMausbotDesktopSession("desktop", {
        subject: "one-time-token",
        method: "browser-session-cookie",
      }),
    ).toBe(false);
    expect(
      isMausbotDesktopSession("desktop", {
        subject: "remote-owner",
        method: "bearer-access-token",
      }),
    ).toBe(false);
    expect(
      isMausbotDesktopSession("web", {
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      }),
    ).toBe(false);
    expect(
      isMausbotDesktopSession("desktop", {
        subject: "desktop-bootstrap",
        method: "browser-session-cookie",
      }),
    ).toBe(false);
  });
});
