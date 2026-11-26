import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@j1code/marketing...'",
  buildCommand: "vp run --filter @j1code/marketing build",
  outputDirectory: "dist",
  // One URL per page: `/download/` and `/download` both served 200 before, which splits ranking signals.
  trailingSlash: false,
  // curl | sh requires plain, uncompressed scripts with no cache across deploys.
  headers: [
    {
      source: "/install.sh",
      headers: [
        { key: "Content-Type", value: "text/x-shellscript; charset=utf-8" },
        { key: "Cache-Control", value: "public, max-age=300" },
      ],
    },
    {
      source: "/install.ps1",
      headers: [
        { key: "Content-Type", value: "text/plain; charset=utf-8" },
        { key: "Cache-Control", value: "public, max-age=300" },
      ],
    },
  ],
  redirects: [
    {
      source: "/app",
      destination: "/download",
      permanent: true,
    },
    // J1 mobile builds and installation guidance live on its download page.
    {
      source: "/mobile",
      destination: "/download",
      permanent: false,
    },
  ],
};
