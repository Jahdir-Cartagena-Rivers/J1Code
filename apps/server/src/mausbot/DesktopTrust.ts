import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";

/** The subject is minted only by J1's private desktop bootstrap grant, never by ordinary browser pairing. */
export const isMausbotDesktopSession = (
  mode: "web" | "desktop",
  session: Pick<AuthenticatedSession, "subject" | "method">,
) =>
  mode === "desktop" &&
  session.subject === "desktop-bootstrap" &&
  session.method !== "browser-session-cookie";
