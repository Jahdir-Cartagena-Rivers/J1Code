import { GITHUB_REPOSITORY_URL } from "./site";
import { J1_SOURCE_URL } from "@j1code/shared/j1Brand";

const configuredSite = process.env.J1CODE_MARKETING_SITE_URL;
const siteUrl = configuredSite ? new URL(configuredSite) : undefined;
if (siteUrl && !["https:", "http:"].includes(siteUrl.protocol)) {
  throw new Error("J1CODE_MARKETING_SITE_URL must use HTTP or HTTPS");
}
export const SITE_ORIGIN = siteUrl?.href;
export const SITE_NAME = "J1 Code";
export const SITE_TAGLINE = "A source-available workspace for coding agents";

// The canonical set of official properties. Search engines and AI answer engines read `sameAs`
// to tie an entity to its real homes, which is the signal a look-alike domain cannot copy.
export const OFFICIAL_PROFILES = [GITHUB_REPOSITORY_URL] as const;

export type JsonLd = Record<string, unknown>;

const ORGANIZATION_ID = absoluteUrl("/#organization");
const WEBSITE_ID = absoluteUrl("/#website");
const SOFTWARE_ID = absoluteUrl("/#software");

export function absoluteUrl(pathname: string): string {
  return SITE_ORIGIN ? new URL(pathname, SITE_ORIGIN).href : pathname;
}

export const organizationJsonLd = (): JsonLd => SITE_ORIGIN ? ({
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: "J1 Code maintainers",
  url: SITE_ORIGIN,
  logo: absoluteUrl("/apple-touch-icon.png"),
  sameAs: [...OFFICIAL_PROFILES],
}) : {};

export const websiteJsonLd = (): JsonLd => SITE_ORIGIN ? ({
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: SITE_NAME,
  url: SITE_ORIGIN,
  publisher: { "@id": ORGANIZATION_ID },
}) : {};

export const softwareJsonLd = (description: string): JsonLd => SITE_ORIGIN ? ({
  "@type": "SoftwareApplication",
  "@id": SOFTWARE_ID,
  name: SITE_NAME,
  description,
  url: SITE_ORIGIN,
  downloadUrl: absoluteUrl("/download"),
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Windows, Linux, iOS, Android",
  license: `${J1_SOURCE_URL}/LICENSE`,
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  publisher: { "@id": ORGANIZATION_ID },
  sameAs: [...OFFICIAL_PROFILES],
}) : {};

export const breadcrumbJsonLd = (items: ReadonlyArray<{ name: string; path: string }>): JsonLd => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map((item, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: item.name,
    item: absoluteUrl(item.path),
  })),
});

export const jsonLdGraph = (nodes: ReadonlyArray<JsonLd>): string =>
  // `<` is escaped so page text inside the graph can never close the script tag.
  JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }).replace(/</g, "\\u003c");

// Indexable static pages. The 404 (noindex) and the /95 easter egg stay out of the sitemap.
export const STATIC_PAGES = [
  { path: "/", priority: "1.0" },
  { path: "/download", priority: "0.9" },
  { path: "/legal", priority: "0.3" },
  { path: "/privacy-policy", priority: "0.3" },
  { path: "/security-policy", priority: "0.3" },
  { path: "/terms-of-service", priority: "0.3" },
] as const;
