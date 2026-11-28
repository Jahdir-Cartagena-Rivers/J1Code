import {
  J1_PROJECT_FILE_NAME,
  type EnvironmentId,
  type J1ProjectFile,
  type J1ProjectFileScript,
} from "@j1code/contracts";
import { parseJ1ProjectFile } from "@j1code/shared/j1ProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<J1ProjectFileScript> = [];

export interface J1ProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: J1ProjectFile | null;
  scripts: ReadonlyArray<J1ProjectFileScript>;
  refresh: () => void;
}

export function useJ1ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): J1ProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", J1_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const { isPending, refresh } = query;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
      refresh,
    } as const;
  }
  const file = parseJ1ProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS, refresh } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS, refresh } as const;
}
