import * as AssetSigner from "./AssetSigner.ts";
import * as DocumentText from "../provider/DocumentText.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { describe, expect, it } from "@effect/vitest";
import {
  AttachmentCreateUploadUrlInput,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ChatAttachmentId,
  WS_METHODS,
  WsRpcGroup,
} from "@j1code/contracts";
import * as Clock from "effect/Clock";
import { HttpRouter } from "effect/http";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as PayloadSigner from "../auth/PayloadSigner.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerHttp from "../http.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as BuiltInSourceControlDrivers from "../sourceControl/builtInDrivers.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import * as AssetAccess from "./AssetAccess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ServerConfig from "../config.ts";
import {
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "../orchestration-v2/AttachmentClaims.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  deletePendingAttachment,
  issueAttachmentUploadUrl,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./AttachmentUpload.ts";

const layerTest = AssetSigner.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-upload-" })),
  Layer.provideMerge(
    DocumentText.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 6,
} as const;

const LegacyAttachmentUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
const encodeLegacyAttachmentUploadClaims = Schema.encodeEffect(
  Schema.fromJsonString(LegacyAttachmentUploadClaims),
);

describe("AttachmentUpload", () => {
  it.effect("serves signed JPEG and file uploads through the in-process HTTP routes", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const clock = yield* Clock.Clock;
      const signer = yield* AssetSigner.AssetSigner;
      const documents = yield* DocumentText.DocumentText;
      const rpcMethods = [
        WS_METHODS.attachmentsCreateUploadUrl, WS_METHODS.attachmentsDelete, WS_METHODS.assetsCreateUrl,
      ] as const;
      type UploadMethod = (typeof rpcMethods)[number];
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, UploadMethod> =>
            !rpcMethods.some((method) => tag === method),
        ),
      );
      const activeDependencies = Layer.mergeAll(
        Layer.succeed(ServerConfig.ServerConfig, config),
        Layer.succeed(DocumentText.DocumentText, documents),
        Layer.succeed(Clock.Clock, clock),
        NodeServices.layer,
        NodeCrypto.layer,
      );
      const makeClient = (scopes: ReadonlyArray<
        typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope
      >) =>
        RpcTest.makeClient(group).pipe(
          Effect.provide(Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.attachmentsCreateUploadUrl, issueAttachmentUploadUrl),
            group.toLayerHandler(WS_METHODS.attachmentsDelete, ({ attachmentId }) =>
              deletePendingAttachment(attachmentId)
            ),
            group.toLayerHandler(WS_METHODS.assetsCreateUrl, (input) =>
              AssetAccess.issueAssetUrl({ resource: input.resource })
            ).pipe(Layer.provide(Layer.mergeAll(
              WorkspacePaths.layer,
              Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
              Layer.mock(Orchestrator.OrchestratorV2)({}),
            ))),
            RpcAuthorization.layer(scopes),
          ).pipe(Layer.provideMerge(Layer.merge(
            activeDependencies, Layer.succeed(AssetSigner.AssetSigner, signer),
          )))),
        );
      const reader = yield* makeClient([AuthOrchestrationReadScope]);
      const operator = yield* makeClient([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      const buildApp = (key: AssetSigner.AssetSigner["Service"]) =>
        Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(
            Layer.mergeAll(
              ServerHttp.layerAttachmentUploadRoute, ServerHttp.layerAssetRoute, ServerHttp.layerBrowserApiCors,
            ).pipe(
              Layer.provideMerge(Layer.mergeAll(
                Layer.succeed(AssetSigner.AssetSigner, key),
                Layer.mock(Orchestrator.OrchestratorV2)({}),
                Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
                Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
                Layer.succeed(BuiltInSourceControlDrivers.SourceControlDrivers, []),
                NodeHttpPlatform.layer,
              )),
              Layer.provideMerge(activeDependencies),
            ), { disableLogger: true },
          )),
          (app) => Effect.promise(() => app.dispose()),
        );
      const app = yield* buildApp(signer);
      const foreignSigner = yield* PayloadSigner.fromSecret(new Uint8Array(32).fill(0x21));
      const foreignApp = yield* buildApp(foreignSigner);
      const origin = "https://uploads.example.test";
      const url = (path: string) => new URL(path, "http://127.0.0.1");
      const post = (path: string, body: Uint8Array | ReadableStream<Uint8Array>, length?: string) => {
        const init = {
          method: "POST",
          headers: { origin, ...(length === undefined ? {} : { "content-length": length }) },
          body: body instanceof Uint8Array ? new Uint8Array(body) : body,
          duplex: "half" as const,
        };
        return new Request(url(path), init);
      };
      const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 2, 0, 3]);
      const input = { name: "photo.jpeg", mimeType: "image/jpeg", sizeBytes: jpeg.length } as const;
      expect(yield* reader[WS_METHODS.attachmentsCreateUploadUrl](input).pipe(Effect.flip))
        .toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredScope: AuthOrchestrationOperateScope });
      const decode = Schema.decodeUnknownOption(AttachmentCreateUploadUrlInput);
      expect(decode({ ...input, sizeBytes: 0 })._tag).toBe("None");
      expect(decode({ ...input, sizeBytes: Number.MAX_SAFE_INTEGER })._tag).toBe("None");

      const issued = yield* operator[WS_METHODS.attachmentsCreateUploadUrl](input);
      const workspaceContext = yield* Layer.build(WorkspacePaths.layer);
      const send = (request: Request) => Effect.promise(() => app.handler(request, workspaceContext));
      expect((yield* send(post(issued.relativeUrl, jpeg, "3"))).status).toBe(400);
      expect((yield* Effect.promise(() => foreignApp.handler(post(issued.relativeUrl, jpeg), workspaceContext))).status).toBe(404);
      expect((yield* send(post(issued.relativeUrl + ".invalid", jpeg))).status).toBe(404);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
      expect((yield* send(post(issued.relativeUrl, jpeg.slice(0, 3)))).status).toBe(400);

      const cancellation = Promise.withResolvers<void>();
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(jpeg.slice(0, 4));
          controller.enqueue(new Uint8Array(jpeg.length));
        },
        cancel: () => cancellation.resolve(),
      });
      expect((yield* send(post(issued.relativeUrl, chunked))).status).toBe(400);
      yield* Effect.promise(() => cancellation.promise);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);

      const response = yield* send(post(issued.relativeUrl, jpeg, String(jpeg.length)));
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.jpg`)))
        .toEqual(Buffer.from(jpeg));
      const preview = yield* reader[WS_METHODS.assetsCreateUrl]({
        resource: { _tag: "attachment", attachmentId: issued.attachmentId, mimeType: "image/jpeg" },
      });
      expect(preview.imageDimensions).toEqual({ width: 3, height: 2 });
      const jpegResponse = yield* send(new Request(url(preview.relativeUrl)));
      expect(jpegResponse.status).toBe(200);
      expect(jpegResponse.headers.get("content-type")).toBe("image/jpeg");
      expect(new Uint8Array(yield* Effect.promise(() => jpegResponse.arrayBuffer()))).toEqual(jpeg);
      expect(yield* reader[WS_METHODS.attachmentsDelete]({ attachmentId: issued.attachmentId }).pipe(Effect.flip))
        .toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredScope: AuthOrchestrationOperateScope });
      const claimed = yield* claimPendingAttachments({
        threadId: "jpeg-upload-thread",
        attachments: [{ ...input, type: "image", id: ChatAttachmentId.make(issued.attachmentId) }],
      });
      const claimedId = claimed.attachments[0]!.id;
      yield* operator[WS_METHODS.attachmentsDelete]({ attachmentId: claimedId });
      expect(NodeFS.readFileSync(claimed.claimedPaths[0]!)).toEqual(Buffer.from(jpeg));
      yield* operator[WS_METHODS.attachmentsDelete]({ attachmentId: issued.attachmentId });
      expect((yield* send(new Request(url(preview.relativeUrl)))).status).toBe(404);
      expect(NodeFS.readFileSync(claimed.claimedPaths[0]!)).toEqual(Buffer.from(jpeg));
      yield* releaseClaimedAttachments(claimed.claimedPaths);
      expect(NodeFS.existsSync(claimed.claimedPaths[0]!)).toBe(false);

      const file = Uint8Array.from([1, 2, 3, 4, 5, 6]);
      const doc = yield* operator[WS_METHODS.attachmentsCreateUploadUrl]({
        type: "file", name: "report.pdf", mimeType: "application/pdf", sizeBytes: file.length,
      });
      const streamed = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(file.slice(0, 3));
          controller.enqueue(file.slice(3));
          controller.close();
        },
      });
      expect((yield* send(post(doc.relativeUrl, streamed))).status).toBe(204);
      for (const metadata of [{ fileName: "report.pdf", mimeType: "application/pdf" }, {}]) {
        const signed = yield* reader[WS_METHODS.assetsCreateUrl]({
          resource: { _tag: "attachment", attachmentId: doc.attachmentId, ...metadata },
        });
        const download = yield* send(new Request(url(signed.relativeUrl)));
        expect(download.status).toBe(200);
        expect(download.headers.get("content-disposition")).toBe(
          metadata.fileName ? 'attachment; filename="report.pdf"' : "attachment",
        );
        expect(download.headers.get("content-type")).toBe(metadata.mimeType ?? "application/octet-stream");
        expect(new Uint8Array(yield* Effect.promise(() => download.arrayBuffer()))).toEqual(file);
      }
      yield* operator[WS_METHODS.attachmentsDelete]({ attachmentId: doc.attachmentId });

      // The token was valid through upload and deletion. Its expiry must prevent re-publishing.
      yield* TestClock.setTime(issued.expiresAt);
      expect((yield* send(post(issued.relativeUrl, jpeg))).status).toBe(404);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "persists and replays immutable uploads (hard links unsupported: %s)",
    (unsupported) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = (claims: Parameters<typeof storeAttachmentUpload>[0], bytes: Uint8Array) =>
          storeAttachmentUpload(claims, bytes).pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              unsupported
                ? {
                    ...fileSystem,
                    link: () =>
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "Unknown",
                          module: "FileSystem",
                          method: "link",
                        }),
                      ),
                  }
                : fileSystem,
            ),
          );
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            cells: [{ cell_type: "markdown", source: ["# Cargo\n", "Violet crates: 19"] }],
          }),
        );
        const issued = yield* issueAttachmentUploadUrl({
          type: "file",
          name: "cargo.ipynb",
          mimeType: "application/x-ipynb+json",
          sizeBytes: bytes.length,
        });
        const claims = yield* validateAttachmentUploadToken(
          issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length),
        );
        if (!claims) throw new Error("Expected upload claims");
        expect(yield* store(claims, bytes)).toEqual({ ok: true });
        expect(yield* store(claims, bytes)).toEqual({ ok: true });
        const path = NodePath.join(config.attachmentsDir, `${issued.attachmentId}.ipynb`);
        expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("Violet crates: 19");
        const replacement = new TextEncoder().encode(
          new TextDecoder().decode(bytes).replace("Violet crates: 19", "Violet crates: 28"),
        );
        expect(yield* store(claims, replacement)).toMatchObject({
          ok: false,
          status: 409,
        });
        expect(NodeFS.readFileSync(path)).toEqual(Buffer.from(bytes));
        expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("Violet crates: 19");
        const claimed = yield* claimPendingAttachments({
          threadId: "document-thread",
          attachments: [
            {
              type: "file",
              id: ChatAttachmentId.make(issued.attachmentId),
              name: claims.name,
              mimeType: claims.mimeType,
              sizeBytes: bytes.length,
            },
          ],
        });
        expect(claimed.claimedPaths).toHaveLength(2);
        expect(NodeFS.readFileSync(claimed.claimedPaths[1]!, "utf8")).toContain(
          "Violet crates: 19",
        );
        yield* deletePendingAttachment(issued.attachmentId);
        expect(NodeFS.existsSync(path)).toBe(false);
        expect(NodeFS.existsSync(`${path}.txt`)).toBe(false);
        expect(NodeFS.existsSync(claimed.claimedPaths[1]!)).toBe(true);
        yield* releaseClaimedAttachments(claimed.claimedPaths);
        expect(NodeFS.existsSync(claimed.claimedPaths[1]!)).toBe(false);
      }).pipe(Effect.provide(layerTest)),
  );
  it.effect("rejects tampered and malformed upload tokens", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const [payload, signature] = token.split(".");

      expect(yield* validateAttachmentUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateAttachmentUploadToken(`${token}.extra`)).toBeNull();
      expect(yield* validateAttachmentUploadToken("garbage")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("accepts unexpired image upload tokens issued before file support", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const signer = yield* AssetSigner.AssetSigner;
      const encodedPayload = base64UrlEncode(
        yield* encodeLegacyAttachmentUploadClaims({
          version: 1,
          kind: "attachment-upload",
          attachmentId: issued.attachmentId,
          name: uploadInput.name,
          mimeType: uploadInput.mimeType,
          sizeBytes: uploadInput.sizeBytes,
          expiresAt: issued.expiresAt,
        }),
      );
      const legacyToken = `${encodedPayload}.${yield* signer.sign(encodedPayload)}`;

      expect(yield* validateAttachmentUploadToken(legacyToken)).toMatchObject({
        type: "image",
        attachmentId: issued.attachmentId,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stores the expected bytes without leaving temporary files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, new Uint8Array([1, 2, 3]))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(yield* storeAttachmentUpload(claims, new Uint8Array(6))).toEqual({ ok: true });
      expect(
        NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`)),
      ).toBe(true);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("streams generic files to a path with their original extension", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl({
        type: "file",
        name: "report.PDF",
        mimeType: "application/pdf",
        sizeBytes: 6,
      });
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(
        yield* storeAttachmentUpload(
          claims,
          Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
        ),
      ).toEqual({ ok: true });
      expect(issued.attachmentId).toMatch(/-pdf$/);
      expect(
        NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.pdf`)),
      ).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));

      yield* deletePendingAttachment(issued.attachmentId);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stores MIME-identified SVG files with a previewable signed extension", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
      for (const name of ["diagram", "diagram.bin"]) {
        const issued = yield* issueAttachmentUploadUrl({
          type: "file",
          name,
          mimeType: "image/svg+xml",
          sizeBytes: bytes.length,
        });
        const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
        const claims = yield* validateAttachmentUploadToken(token);
        if (!claims) throw new Error("Expected valid SVG upload claims.");
        expect(claims.name).toBe(`${name}.svg`);
        expect(issued.attachmentId).toMatch(/-svg$/);
        expect(yield* storeAttachmentUpload(claims, bytes)).toEqual({ ok: true });
        expect(
          NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.svg`)),
        ).toEqual(Buffer.from(bytes));
        const claimed = yield* claimPendingAttachments({
          threadId: "svg-upload-thread",
          attachments: [
            {
              type: "file",
              id: ChatAttachmentId.make(issued.attachmentId),
              name,
              mimeType: "image/svg+xml",
              sizeBytes: bytes.length,
            },
          ],
        });
        expect(claimed.attachments[0]?.name).toBe(`${name}.svg`);
        expect(NodeFS.readFileSync(claimed.claimedPaths[0]!)).toEqual(Buffer.from(bytes));
        yield* releaseClaimedAttachments(claimed.claimedPaths);
        yield* deletePendingAttachment(issued.attachmentId);
      }
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("removes partial streamed uploads that exceed their signed size", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, Stream.make(new Uint8Array(7)))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("removes partial streamed uploads when the upload is interrupted", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const nextChunkRequested = yield* Deferred.make<void>();
      const body = Stream.make(new Uint8Array([1, 2, 3])).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.succeed(nextChunkRequested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
      const upload = yield* storeAttachmentUpload(claims, body).pipe(Effect.forkScoped);

      yield* Deferred.await(nextChunkRequested);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toHaveLength(1);

      yield* Fiber.interrupt(upload);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("deletes pending uploads without deleting thread-owned copies", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const uuid = "00000000-0000-4000-8000-0000000000dd";
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${uuid}.png`);
      const claimedPath = NodePath.join(config.attachmentsDir, `thread-1-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      NodeFS.writeFileSync(claimedPath, Buffer.from("pixels"));

      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`thread-1-${uuid}`);

      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(claimedPath)).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );
});
