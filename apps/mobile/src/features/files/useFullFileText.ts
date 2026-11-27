import { useAtomValue } from "@effect/atom-react";
import type { AssetResource, EnvironmentId, ThreadId } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAssetUrlState } from "../../state/assets";

export const MOBILE_FULL_FILE_MAX_BYTES = 8 * 1024 * 1024;

export function readBoundedMobileFileText(response: HttpClientResponse.HttpClientResponse) {
  // The file can grow between preview and download. React Native buffers the body.
  const header = response.headers["content-length"];
  const length = header && /^\d+$/.test(header) ? Number(header) : Number.NaN;
  return Number.isSafeInteger(length) && length <= MOBILE_FULL_FILE_MAX_BYTES
    ? response.text
    : Effect.succeed(null);
}

const fullFileTextAtom = Atom.family((key: string) => {
  const [url] = JSON.parse(key) as [string, string];
  return connectionAtomRuntime.atom(
    HttpClient.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(readBoundedMobileFileText),
      Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
    ),
  );
});
const noText = Atom.make(AsyncResult.success(null));

export function useFullFileText(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly absolutePath: string | null;
  readonly revision: string;
}): string | null {
  const { threadId, absolutePath } = input;
  const resource = useMemo<AssetResource | null>(
    () =>
      threadId === null || absolutePath === null
        ? null
        : { _tag: "media-file", threadId, path: absolutePath, disposition: "attachment" },
    [threadId, absolutePath],
  );
  const asset = useAssetUrlState(input.environmentId, resource, input.revision);
  const url = resource !== null && asset._tag === "Success" ? asset.url : null;
  const result = useAtomValue(
    url === null ? noText : fullFileTextAtom(JSON.stringify([url, input.revision])),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}
