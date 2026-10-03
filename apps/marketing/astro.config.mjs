import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.J1CODE_MARKETING_SITE_URL,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
