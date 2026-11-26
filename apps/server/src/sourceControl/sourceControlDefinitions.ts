import * as AzureDevOpsDriver from "@j1code/source-control-azure-devops/server/driver";
import * as BitbucketDriver from "@j1code/source-control-bitbucket/server/driver";
import * as CursorOriginDriver from "@j1code/source-control-cursor-origin/server/driver";
import { builtInSourceControlDefinitions } from "@j1code/source-control-definitions/registry";
import * as ForgejoDriver from "@j1code/source-control-forgejo/server/driver";
import * as GitCafeDriver from "@j1code/source-control-gitcafe/server/driver";
import * as GitHubDriver from "@j1code/source-control-github/server/driver";
import * as GitLabDriver from "@j1code/source-control-gitlab/server/driver";

/** In the shared registry's order, which is the order hosts are listed and probed in. */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [
  GitHubDriver.driver,
  CursorOriginDriver.driver,
  GitLabDriver.driver,
  GitCafeDriver.driver,
  ForgejoDriver.driver,
  BitbucketDriver.driver,
  AzureDevOpsDriver.driver,
] as const;

export const sourceControlDefinitions = builtInSourceControlDefinitions;
