import { logger } from "@/lib/logger";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";
import { escapeHtml } from "@/lib/renderEmailTemplate";
import { serveBlobFile, safeFilename } from "@/lib/serveBlobFile";
import { verifyDocumentLinkToken } from "@/lib/documentLink";

/**
 * GET /api/document-link/download?token=...[&i=<index>][&dl=1]
 *
 * The link an email uses for a document it could not carry as an attachment.
 *
 *   ?token=...          the document itself when the link covers exactly one
 *                       (the usual case); otherwise a page listing them
 *   ?token=...&i=2      the third document on the token
 *   &dl=1               save it instead of opening it in the browser
 *
 * PUBLIC BY CONSTRUCTION: it sits outside /api/admin, so src/middleware.ts never
 * runs on it — which is the entire point. These links previously pointed at
 * /api/admin/documents/download and returned {"success":false,"error":
 * "Unauthorized"} to every clerk who clicked one from their inbox.
 *
 * The token IS the authorisation, and it authorises exactly the blob URLs
 * recorded on it. The document is chosen by INDEX into that list, so a
 * recipient editing the query string can reach nothing that is not already on
 * their own token — there is no URL parameter to tamper with.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The small page used for the listing and for every error state. */
function page(opts: { heading: string; body: string; status?: number }): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(opts.heading)}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 40px 16px; background: #f8fafc; color: #0f172a;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  }
  .card {
    max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 14px;
    border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 1px 3px rgba(15,23,42,.06);
  }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 16px; color: #475569; }
  ul { list-style: none; margin: 24px 0 0; padding: 0; }
  li { border-top: 1px solid #f1f5f9; padding: 14px 0; }
  li:last-child { border-bottom: 1px solid #f1f5f9; }
  .name { font-weight: 600; word-break: break-word; }
  a.btn {
    display: inline-block; margin-top: 8px; background: #C10007; color: #ffffff;
    text-decoration: none; padding: 9px 18px; border-radius: 8px; font-weight: 600;
  }
  a.save {
    display: inline-block; margin-left: 14px; color: #C10007; font-size: 13px;
    font-weight: 600; text-decoration: none;
  }
  a.save:hover { text-decoration: underline; }
  .foot { margin-top: 28px; font-size: 13px; color: #64748b; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(opts.heading)}</h1>
    ${opts.body}
  </div>
</body>
</html>`;

  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // A tokenised page must never sit in a shared cache.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

const errorPage = (heading: string, message: string, status: number) =>
  page({
    heading,
    body:
      `<p>${escapeHtml(message)}</p>` +
      `<p class="foot">The document is always on the file in the admin portal, ` +
      `and re-sending the email mints a fresh link.</p>`,
    status,
  });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const token = url.searchParams.get("token") ?? "";
  const rawIndex = url.searchParams.get("i");
  const forceDownload = url.searchParams.get("dl") === "1";

  // Throttle per IP: the token is the only credential, so guessing must be slow.
  if (!(await rateLimitOk(`doc-link:ip:${requestIp(req)}`, 60, 600))) {
    return errorPage(
      "Too many attempts",
      "Please wait a few minutes and open the link from your email again.",
      429,
    );
  }

  const verified = await verifyDocumentLinkToken(token);
  if (!verified.ok) {
    return errorPage(
      verified.reason === "expired" ? "This link has expired" : "This link is no longer valid",
      verified.reason === "expired"
        ? "For security, document links expire. Ask for the email to be sent again and you will get a fresh one."
        : "We could not open this link. It may have been replaced by a newer one.",
      410,
    );
  }

  const { docs } = verified.scope;

  // A link covering ONE document IS that document — no page whose only content
  // is a single button. An explicit &i= always wins.
  const index =
    rawIndex !== null ? Number(rawIndex) : docs.length === 1 ? 0 : null;

  if (index !== null) {
    if (!Number.isInteger(index) || index < 0 || index >= docs.length) {
      return errorPage(
        "This link is no longer valid",
        "That document is not part of this link.",
        403,
      );
    }
    const doc = docs[index];
    const served = await serveBlobFile({
      fileUrl: doc.url,
      filename: safeFilename(doc.name, "document"),
      forceDownload,
      logLabel: "[DocumentLink]",
    });
    if (served.ok) return served.response;

    logger.warn(`[DocumentLink] could not serve index ${index} (${served.reason})`);
    return served.reason === "missing"
      ? errorPage(
          "This document is no longer available",
          "The document this link pointed at has been removed.",
          410,
        )
      : errorPage(
          "Something went wrong",
          "We could not fetch the document just now. Please try again shortly.",
          500,
        );
  }

  // Several documents: list them. Each opens in the browser, with a save link
  // beside it for anyone who wants the file on disk.
  const items = docs
    .map((doc, i) => {
      const href = `${origin}/api/document-link/download?token=${encodeURIComponent(
        token,
      )}&i=${i}`;
      return (
        `<li><div class="name">${escapeHtml(doc.name || `Document ${i + 1}`)}</div>` +
        `<a class="btn" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open</a>` +
        `<a class="save" href="${escapeHtml(href)}&amp;dl=1">Download</a></li>`
      );
    })
    .join("");

  return page({
    heading: "Documents from this file",
    body:
      `<p>These ${docs.length} documents were too large to attach to the email.</p>` +
      `<ul>${items}</ul>`,
  });
}
