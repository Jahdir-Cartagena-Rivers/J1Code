import { J1_PROJECT_FILE_NAME, type EnvironmentId, type J1ProjectFile } from "@j1code/contracts";
import { parseJ1ProjectFile } from "@j1code/shared/j1ProjectFile";
import { executeAtomQuery } from "@j1code/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read and decode the project's checked-in `t3.json`.
 *
 * Imperative counterpart to `useJ1ProjectFileState` for the new-thread path,
 * which resolves defaults at call time rather than render time. The file
 * query atom caches per (environment, cwd), so repeat calls don't re-fetch.
 * Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readJ1ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<J1ProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, J1_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    J1_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseJ1ProjectFile(data.contents);
}
