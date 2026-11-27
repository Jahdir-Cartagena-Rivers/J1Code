import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import { MOBILE_FULL_FILE_MAX_BYTES, readBoundedMobileFileText } from "./useFullFileText";

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/assets", () => ({ useAssetUrlState: vi.fn() }));

it.effect(
  "reads a file that fits on mobile and can replace a preview when the file shrinks to empty",
  () =>
    Effect.gen(function* () {
      for (const body of ["full text", ""]) {
        const response = new Response(body, { headers: { "content-length": String(body.length) } });
        const result = HttpClientResponse.fromWeb(
          HttpClientRequest.get("http://localhost/file"),
          response,
        );
        expect(yield* readBoundedMobileFileText(result)).toBe(body);
      }
    }),
);

it.effect.each([undefined, "-1", "1.5", String(MOBILE_FULL_FILE_MAX_BYTES + 1)])(
  "keeps the preview and leaves the response body untouched for length %s",
  (length) =>
    Effect.gen(function* () {
      const response = new Response("partial content", {
        headers: length === undefined ? {} : { "content-length": length },
      });
      const result = HttpClientResponse.fromWeb(
        HttpClientRequest.get("http://localhost/file"),
        response,
      );
      expect(yield* readBoundedMobileFileText(result)).toBeNull();
      expect(response.bodyUsed).toBe(false);
    }),
);
