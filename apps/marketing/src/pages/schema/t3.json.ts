import type { APIRoute } from "astro";

import { buildJ1ProjectFileJsonSchema } from "@j1code/shared/j1ProjectFile";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildJ1ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
