export const SAVED_APP_FILE_KEY_HEADER = "x-j1-local-app-file-key";
export const SAVED_APP_VIEW_HEADER = "x-j1-local-app-view";
export const SAVED_APP_FILE_PREFIX = "/api/mausbot/local-app-files/";
export const UPSTREAM_SAVED_APP_FILE_PREFIX = "/api/local-app-files/";
export const savedAppFileKey = /^[A-Za-z0-9_-]{43}$/u;
export const savedAppDocumentPath = /^\/api\/local-apps\/la_[A-Za-z0-9_-]{16}\/app$/u;
export const upstreamSavedAppFilePath = /^\/api\/local-app-files\/([A-Za-z0-9_-]{43})\/.*$/u;
