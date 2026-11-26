import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { J1ProjectFile, J1_PROJECT_FILE_SCHEMA_URL } from "@j1code/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const J1ProjectFileFromJson = fromLenientJson(J1ProjectFile);

const decodeJ1ProjectFile = Schema.decodeExit(J1ProjectFileFromJson);

export function parseJ1ProjectFile(contents: string): J1ProjectFile | null {
  const decoded = decodeJ1ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildJ1ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(J1ProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: J1_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
