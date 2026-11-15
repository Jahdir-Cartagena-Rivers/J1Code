import {
  J1_PROJECT_FILE_NAME,
  type EnvironmentId,
  type J1ProjectFile,
  type J1ProjectFileScript,
} from "@j1code/contracts";
import { parseJ1ProjectFile } from "@j1code/shared/j1ProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<J1ProjectFileScript> = [];

export interface J1ProjectFileState {
  /**
   * - `valid`: t3.json exists and decoded.
   * - `invalid`: t3.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable t3.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: J1ProjectFile | null;
  scripts: ReadonlyArray<J1ProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `t3.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useJ1ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): J1ProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", J1_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseJ1ProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useJ1ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<J1ProjectFileScript> {
  return useJ1ProjectFileState(environmentId, cwd).scripts;
}
