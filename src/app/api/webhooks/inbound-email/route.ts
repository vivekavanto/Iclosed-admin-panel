import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { ingestInboundEmail } from "@/lib/dealMessages";
import { logger } from "@/lib/logger";

/**
 * POST /api/webhooks/inbound-email?secret=...
 *
 * Receives a client's emailed reply to a "Client Message" notification and
 * files it into the file's chat thread. Point the inbound-mail provider's
 * webhook at this URL (see docs/client-messaging.md).
 *
 * Auth: ?secret= must equal INBOUND_EMAIL_WEBHOOK_SECRET. Unset secret = the
 * route refuses everything (fail closed). Beyond that, the recipient address is
 * itself an HMAC-signed per-file token and the sender must be a client on that
 * file, so a leaked URL alone cannot post into a thread.
 *
 * Accepts two shapes:
 *   - Resend inbound `email.received` event (metadata only; the body is fetched
 *     from Resend's receiving API with RESEND_API_KEY)
 *   - a plain JSON { from, to, text, message_id } for any other provider/relay
 */
export function OPTIONS() {
  return new NextResponse(null, { status: 405 });
}

function secretOk(given: string | null): boolean {
  const want = process.env.INBOUND_EMAIL_WEBHOOK_SECRET ?? "";
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function addresses(v: unknown): string[] {
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  return list
    .map((x) => (typeof x === "string" ? x : (x as { email?: string; address?: string })?.email ?? (x as { address?: string })?.address ?? ""))
    .filter(Boolean);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function POST(req: NextRequest) {
  if (!secretOk(req.nextUrl.searchParams.get("secret"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const payload = (await req.json()) as Record<string, any>;
    const data = (payload.type === "email.received" ? payload.data : payload) ?? {};

    let text: string = typeof data.text === "string" ? data.text : "";
    if (!text && typeof data.html === "string") text = htmlToText(data.html);

    // Resend sends metadata only — fetch the body.
    if (!text && payload.type === "email.received" && data.email_id && process.env.RESEND_API_KEY) {
      const res = await fetch(`https://api.resend.com/emails/receiving/${data.email_id}`, {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      if (res.ok) {
        const full = (await res.json()) as { text?: string; html?: string };
        text = full.text || (full.html ? htmlToText(full.html) : "");
      } else {
        logger.error(`[inbound-email] could not fetch body from Resend (${res.status})`);
      }
    }

    const fromRaw = addresses(data.from)[0] ?? "";
    const m = /<([^>]+)>/.exec(fromRaw);
    const result = await ingestInboundEmail({
      to: addresses(data.to),
      from: m ? m[1] : fromRaw,
      fromName: m ? fromRaw.replace(/<.*$/, "").trim().replace(/^"|"$/g, "") : null,
      text,
      messageId: data.message_id ?? data.messageId ?? data.email_id ?? null,
    });
    logger.info(`[inbound-email] stored=${result.stored}${result.reason ? ` reason=${result.reason}` : ""}`);

    // Always 200 for a well-formed delivery so the provider doesn't retry mail we
    // deliberately dropped (wrong sender, unknown address, duplicate).
    return NextResponse.json({ success: true, stored: result.stored });
  } catch (err) {
    logger.error("POST /api/webhooks/inbound-email error:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
