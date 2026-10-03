import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    "https://github.com/Jahdir-Rivers/J1Code/blob/j1-code/docs/user/open-source-licenses.md",
    "https://github.com/Jahdir-Rivers/J1Code/blob/j1-code/docs/user/open-source-licenses.md/",
    "https://github.com/Jahdir-Rivers/J1Code/blob/j1-code/docs/user/privacy.md?source=app",
    "https://github.com/Jahdir-Rivers/J1Code/blob/j1-code/LICENSE#license",
    "https://github.com/Jahdir-Rivers/J1Code/blob/j1-code/.github/SECURITY.md",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://t3.codes/download",
    "https://t3.codes/privacy-policy",
    "https://github.com/Jahdir-Rivers/J1Code/blob/j1-code/README.md",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });

  it("uses a configured website without broadening its document allowlist", async () => {
    vi.stubEnv("EXPO_PUBLIC_MARKETING_SITE_URL", "https://j1.example.com/site/?unused=1#old");
    vi.resetModules();
    const configured = await import("./legal-document-url");
    expect(configured.PRIVACY_POLICY_URL).toBe("https://j1.example.com/site/privacy-policy");
    expect(configured.isLegalDocumentUrl(configured.PRIVACY_POLICY_URL)).toBe(true);
    expect(configured.isLegalDocumentUrl("https://j1.example.com/site/download")).toBe(false);
    expect(configured.isLegalDocumentUrl(SOURCE_PRIVACY_URL)).toBe(false);
  });

  it.each(["not-a-url", "javascript:alert(1)"])(
    "uses J1 source documents for an invalid website: %s",
    async (site) => {
      vi.stubEnv("EXPO_PUBLIC_MARKETING_SITE_URL", site);
      vi.resetModules();
      const configured = await import("./legal-document-url");
      expect(configured.PRIVACY_POLICY_URL).toBe(SOURCE_PRIVACY_URL);
      expect(configured.isLegalDocumentUrl("https://t3.codes/privacy-policy")).toBe(false);
    },
  );
});

const SOURCE_PRIVACY_URL =
  "https://github.com/Jahdir-Rivers/J1Code/blob/j1-code/docs/user/privacy.md";
