import {
  SAVED_APP_FILE_KEY_HEADER,
  SAVED_APP_FILE_PREFIX,
  SAVED_APP_VIEW_HEADER,
} from "../../apps/server/src/mausbot/SavedAppFiles.ts";

type Change = (file: string, before: string, after: string) => Promise<void>;

export async function patchSavedAppFiles(change: Change) {
  const managedImport = 'import { managedRuntime } from "../j1/managed-runtime.ts";';
  const routeImport = 'import { z } from "zod";';
  const serviceImport = 'import type { IncomingMessage, ServerResponse } from "node:http";';
  await change("server/routes/local-apps.ts", routeImport, `${routeImport}\n${managedImport}`);
  await change("server/local-apps/service.ts", serviceImport, `${serviceImport}\n${managedImport}`);
  const viewer =
    '      const viewer = { key: auth.kind === "session" ? `session:${auth.session.id}` : auth.kind,';
  await change(
    "server/routes/local-apps.ts",
    viewer,
    `      const managedView = managedRuntime ? req.headers[${JSON.stringify(SAVED_APP_VIEW_HEADER)}] : undefined;
${viewer}
        ...(typeof managedView === "string" && /^[a-f0-9]{64}$/.test(managedView) ? { key: "j1-view:" + managedView } : {}),`,
  );
  const fileUrl =
    "      const filesAt = folder ? `${origin}${LOCAL_APP_FILES_PREFIX}${folder.slice(PAGE_FILES_PREFIX.length)}` : undefined;";
  await change(
    "server/local-apps/service.ts",
    fileUrl,
    fileUrl.replace(
      "LOCAL_APP_FILES_PREFIX",
      `(managedRuntime ? ${JSON.stringify(SAVED_APP_FILE_PREFIX)} : LOCAL_APP_FILES_PREFIX)`,
    ),
  );
  const missingDoc =
    '      if (!doc) return json(res, 404, { error: "That version of the app is no longer kept." });';
  await change(
    "server/routes/local-apps.ts",
    missingDoc,
    `${missingDoc}
      if (managedRuntime && origin) {
        const prefix = origin + ${JSON.stringify(SAVED_APP_FILE_PREFIX)};
        const resource = doc.network.resources.at(-1);
        const key = resource?.startsWith(prefix) ? resource.slice(prefix.length).match(/^([A-Za-z0-9_-]{43})\\/$/)?.[1] : undefined;
        if (key) res.setHeader(${JSON.stringify(SAVED_APP_FILE_KEY_HEADER)}, key);
      }`,
  );
}
