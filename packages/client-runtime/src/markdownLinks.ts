// Keep historical client-runtime imports on the same resolver as current web and mobile callers.
export {
  inlineCodeFilePathCandidate,
  safeDecodeURIComponent,
  normalizeMarkdownLinkDestination,
  splitMarkdownLinkSearchAndHash,
  isRelativeFilePath,
  parseMarkdownFileLink,
} from "@j1code/shared/markdownLinks";
export {
  parseFileUrlHref,
  splitFilePathPosition,
  formatFilePathPosition,
  type FilePathPosition,
} from "@j1code/shared/fileLinks";
export {
  stripSlashPrefixedWindowsDrive,
  fileBasename,
  workspaceRelativeFilePath,
} from "@j1code/shared/path";
