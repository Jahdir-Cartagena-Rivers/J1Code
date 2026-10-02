// @effect-diagnostics nodeBuiltinImport:off - Pin the validated DNS address while retaining hostname TLS verification; the generic HTTP client does not expose this boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DotIntegrationError } from "@t3tools/contracts";

const blocked = new NodeNet.BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, bits, "ipv4");
// Node matches mapped IPv6 ranges against IPv4 too; ::ffff:0:0/96 blocks all IPv4.
for (const [ip, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
] as const)
  blocked.addSubnet(ip, bits, "ipv6");

const globalV6 = new NodeNet.BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const mappedV4 = new NodeNet.BlockList();
mappedV4.addSubnet("::ffff:0:0", 96, "ipv6");
export const isPublicCallbackAddress = (address: string, family: number) =>
  NodeNet.isIP(address) === family &&
  (family === 4 ||
    (family === 6 && (globalV6.check(address, "ipv6") || mappedV4.check(address, "ipv6")))) &&
  !blocked.check(address, family === 6 ? "ipv6" : "ipv4");

export function callbackUrl(value: string): URL {
  const url = new URL(value);
  // This channel belongs to ChatGPT. Don't turn subscriptions into an arbitrary HTTP relay.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !/(^|\.)(openai\.com|chatgpt\.com)$/.test(url.hostname)
  )
    throw new Error("Invalid ChatGPT callback.");
  return url;
}
export function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret)) throw new Error("Invalid signing key.");
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 24 || key.length > 64) throw new Error("Invalid signing key.");
  return key;
}
export function signature(secret: string, id: string, timestamp: string, body: string): string {
  return `v1,${NodeCrypto.createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export class DotChatWebhook extends Context.Service<
  DotChatWebhook,
  {
    readonly post: (input: {
      url: string;
      secret: string;
      previousSecret?: string;
      subscriptionId: string;
      eventId: string;
      body: string;
    }) => Effect.Effect<{ status: number; challenge: string | null }, DotIntegrationError>;
  }
>()("t3/dot/DotChatWebhook") {}

export const layer = Layer.succeed(DotChatWebhook, {
  post: (input) =>
    Effect.gen(function* () {
      const signedAt = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const url = callbackUrl(input.url);
          if (Buffer.byteLength(input.body, "utf8") > 262144) throw new Error("Payload too large.");
          const addresses = await NodeDnsPromises.lookup(url.hostname, { all: true });
          if (
            !addresses.length ||
            addresses.some((a) => !isPublicCallbackAddress(a.address, a.family))
          )
            throw new Error("Non-public callback.");
          const address = addresses[0]!;
          const timestamp = String(Math.floor(signedAt / 1000));
          const signed = [
            signature(input.secret, input.eventId, timestamp, input.body),
            ...(input.previousSecret
              ? [signature(input.previousSecret, input.eventId, timestamp, input.body)]
              : []),
          ].join(" ");
          return new Promise<{ status: number; challenge: string | null }>((resolve, reject) => {
            const request = NodeHttps.request(
              url,
              {
                method: "POST",
                signal,
                timeout: 10000,
                lookup: (_host, options, cb) =>
                  options.all ? cb(null, [address]) : cb(null, address.address, address.family),
                headers: {
                  "content-type": "application/json",
                  "webhook-id": input.eventId,
                  "webhook-timestamp": timestamp,
                  "webhook-signature": signed,
                  "X-MCP-Subscription-Id": input.subscriptionId,
                },
              },
              (response) => {
                let body = "";
                response.on("data", (chunk) => {
                  body += String(chunk);
                  if (Buffer.byteLength(body) > 16384)
                    response.destroy(new Error("Response too large."));
                });
                response.on("error", reject);
                response.on("end", () => {
                  let challenge: string | null = null;
                  try {
                    const parsed: unknown = JSON.parse(body);
                    if (
                      typeof parsed === "object" &&
                      parsed &&
                      "challenge" in parsed &&
                      typeof parsed.challenge === "string"
                    )
                      challenge = parsed.challenge;
                  } catch {
                    /* Event acknowledgements may have no body. */
                  }
                  resolve({ status: response.statusCode ?? 502, challenge });
                });
              },
            );
            request.on("timeout", () => request.destroy(new Error("Callback timed out.")));
            request.on("error", reject);
            request.end(input.body);
          });
        },
        catch: () =>
          new DotIntegrationError({
            message: "ChatGPT callback could not be reached or verified.",
          }),
      });
    }),
});
