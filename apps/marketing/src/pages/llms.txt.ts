import type { APIRoute } from "astro";

import { BUILD_GUIDE_URL, MOBILE_BUILD_GUIDE_URL, GITHUB_REPOSITORY_URL, RELEASES_URL } from "../lib/site";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# J1 Code

> ${SITE_TAGLINE}. J1 Code is independently maintained from T3 Code and serves desktop, web, and mobile clients. Licensing is mixed: consult the repository LICENSE and LICENSING.md. Upstream notices retain their original terms.

## Builds and source

- [Downloads](${absoluteUrl("/download")}): published J1 builds and checksums
- [Source code](${GITHUB_REPOSITORY_URL})
- [Releases](${RELEASES_URL}): release builds and changelogs
- [Build and setup guide](${BUILD_GUIDE_URL}): source builds and server setup
- [Mobile build guide](${MOBILE_BUILD_GUIDE_URL}): build with your own signing identity

Upstream T3 npm packages, installer services, and store apps distribute T3 builds. Supply your own provider accounts and services. Cloud linking is optional.

## Policies

- [Security policy](${absoluteUrl("/security-policy")})
- [Privacy policy](${absoluteUrl("/privacy-policy")})
- [Terms of service](${absoluteUrl("/terms-of-service")})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
