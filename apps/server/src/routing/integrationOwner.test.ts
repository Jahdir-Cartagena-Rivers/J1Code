import { expect, it } from "vite-plus/test";
import { isBuildIntegrationRequest } from "./integrationOwner.ts";
it("recognizes build-integration intent without requiring matching feature task IDs", () => {
  expect(isBuildIntegrationRequest("j1-local-whisper-build-integration")).toBe(true);
  expect(
    isBuildIntegrationRequest(
      "audio",
      "Hand off completed transcription changes to the existing chat coordinating the latest J1 build.",
    ),
  ).toBe(true);
  expect(isBuildIntegrationRequest("audio", "Include these changes in the next release.")).toBe(
    true,
  );
});
it("does not treat all same-project implementation as release coordination", () => {
  expect(isBuildIntegrationRequest("audio", "Fix the audio transcription bug in J1.")).toBe(false);
  expect(isBuildIntegrationRequest("build-debugging", "Investigate why the build fails.")).toBe(
    false,
  );
  expect(isBuildIntegrationRequest("feature", "Build a calendar feature.")).toBe(false);
});
