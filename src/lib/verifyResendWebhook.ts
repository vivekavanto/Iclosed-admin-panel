// Verify that a webhook really came from Resend.
//
// Resend signs webhooks with Svix. Each delivery carries three headers:
//   svix-id         unique message id
//   svix-timestamp  unix seconds
//   svix-signature  space-separated "v1,<base64>" entries (several during a
//                   secret rotation)
// The signature is base64(HMAC-SHA256(secret, `${id}.${timestamp}.${rawBody}`)),
// where the secret is the webhook's signing secret ("whsec_<base64>") with the
// prefix stripped and the rest base64-decoded. Done here with node:crypto so no
// extra dependency is needed.
//
// The secret is per webhook endpoint: Resend dashboard -> Webhooks -> the
// endpoint -> "Signing secret". Set it as RESEND_WEBHOOK_SECRET.

import { createHmac, timingSafeEqual } from "crypto";

/** Reject deliveries older (or newer) than this — blocks replaying a captured request. */
const TOLERANCE_SECONDS = 5 * 60;

export type ResendWebhookCheck = { ok: true } | { ok: false; reason: string };

export function verifyResendWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): ResendWebhookCheck {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const key = Buffer.from(secret.trim().replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return { ok: false, reason: "bad_secret" };
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();

  for (const part of signatures.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}
