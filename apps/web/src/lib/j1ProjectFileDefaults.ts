import { J1_PROJECT_FILE_NAME, type EnvironmentId, type J1ProjectFile } from "@j1code/contracts";
import { parseJ1ProjectFile } from "@j1code/shared/j1ProjectFile";
import { executeAtomQuery } from "@j1code/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readJ1ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<J1ProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, J1_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false, ...(signal ? { signal } : {}) },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    J1_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseJ1ProjectFile(data.contents);
}
