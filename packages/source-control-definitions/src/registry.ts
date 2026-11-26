import * as AzureDevOps from "@j1code/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@j1code/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@j1code/source-control-core/shared/definition";
import * as CursorOrigin from "@j1code/source-control-cursor-origin/shared/definition";
import * as Forgejo from "@j1code/source-control-forgejo/shared/definition";
import * as GitCafe from "@j1code/source-control-gitcafe/shared/definition";
import * as GitHub from "@j1code/source-control-github/shared/definition";
import * as GitLab from "@j1code/source-control-gitlab/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@j1code/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first to preserve the client default for repositories with an unknown host.
 * GitCafe and Cursor Origin claim URLs first because GitHub and Forgejo accept the same routes on
 * any hostname.
 * Remote recognition needs its own order because host labels can overlap (`gitea.github.example`).
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    CursorOrigin.definition,
    GitLab.definition,
    GitCafe.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [
      GitCafe.definition.kind,
      CursorOrigin.definition.kind,
      AzureDevOps.definition.kind,
    ],
    recognizeRemotesIn: [
      GitCafe.definition.kind,
      CursorOrigin.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);
