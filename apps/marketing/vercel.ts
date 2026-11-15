import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@j1code/marketing...'",
  buildCommand: "vp run --filter @j1code/marketing build",
  outputDirectory: "dist",
  redirects: [
    {
      source: "/app",
      destination: "/download",
      permanent: true,
    },
  ],
};
