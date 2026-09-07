import { NextResponse } from "next/server";
import { get } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";
import { isUuid } from "@/lib/isUuid";
import { isPrivateBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";
import { escapeHtml } from "@/lib/renderEmailTemplate";
import { getLeadFirmKey } from "@/lib/leadFirm";
import { getFirm } from "@/lib/firms";
import { verifyFinalReportToken } from "@/lib/finalReportLink";
import { FINAL_REPORT_DOC_TYPE } from "@/lib/sendFinalReportEmail";

/**
 * GET /api/final-report/download?token=...[&doc=<uuid>][&dl=1]
 *
 * The client-facing end of the final reporting package "magic link" — the link
 * the closing email carries INSTEAD of a 15-25 MB attachment no mail server
 * would accept (see finalReportLink.ts for why).
 *
 *   ?token=...            the document itself when the link covers exactly one
 *                         (the usual case); otherwise a page listing them
 *   ?token=...&doc=<id>   that one file
 *   &dl=1                 save it instead of rendering it in the browser
 *
 * IT OPENS, IT DOES NOT SAVE. The email button used to land on a listing page
 * that, for a single-document package, held nothing but a second Download
 * button — an interstitial rather than a step. A link covering one document now
 * serves that document straight away, and serves it INLINE, so the report opens
 * in the browser PDF viewer where the client can read it before deciding to keep
 * it. "&dl=1" is the explicit save variant the listing page uses.
 *
 * PUBLIC BY CONSTRUCTION: it sits outside /api/admin, so src/middleware.ts
 * never runs on it — the recipient has no account and no session, which is the
 * whole point. The token IS the authorisation, and it authorises exactly one
 * thing: the document ids recorded on it. A document id is checked against that
 * list before a single byte is served, so no token can walk to another file's
 * package (or to the other side of its own Purchase & Sale file).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function portalUrl(): string {
  return (
    process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://dev.iclosed.ca"
  ).replace(/\/+$/, "");
}

/**
 * Content types we are willing to render INLINE.
 *
 * An allowlist rather than a blocklist because the private-blob branch below
 * streams the file from OUR OWN origin: anything scriptable served inline there
 * (HTML, SVG) would run as us. uploadValidation.ts already refuses those on the
 * way in — this is the second lock, for rows that predate it. Anything not on
 * the list is still delivered, just as a download.
 */
const INLINE_SAFE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
]);

/** The one page shell both the listing and every error state render into. */
function page(opts: {
  firmName: string;
  logoSrc: string;
  heading: string;
  body: string;
  status?: number;
}): Response {
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
  img.logo { display: block; margin-bottom: 24px; }
</style>
</head>
<body>
  <div class="card">
    <img class="logo" src="${escapeHtml(opts.logoSrc)}" alt="${escapeHtml(opts.firmName)}" width="120" />
    <h1>${escapeHtml(opts.heading)}</h1>
    ${opts.body}
    <p class="foot">${escapeHtml(opts.firmName)}</p>
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const token = url.searchParams.get("token") ?? "";
  const docId = url.searchParams.get("doc");
  // The listing page's save links carry this; the email button does not — so the
  // email opens the report, and the page can still download it.
  const forceDownload = url.searchParams.get("dl") === "1";

  // Default branding for the states where no lead is resolved yet (bad token).
  const defaultFirm = getFirm(null);
  const errorPage = (heading: string, message: string, status: number) =>
    page({
      firmName: defaultFirm.label,
      logoSrc: `${origin}${defaultFirm.logoPath}`,
      heading,
      body:
        `<p>${escapeHtml(message)}</p>` +
        `<p><a class="btn" href="${escapeHtml(portalUrl())}/login">Sign in to your portal</a></p>` +
        `<p class="foot">Your reporting package is always available in the Documents ` +
        `section of your portal, and our team can send you a fresh link.</p>`,
      status,
    });

  // Throttle per IP: the token is the only credential, so guessing must be slow.
  if (!(await rateLimitOk(`final-report-dl:ip:${requestIp(req)}`, 60, 600))) {
    return errorPage(
      "Too many attempts",
      "Please wait a few minutes and open the link from your email again.",
      429,
    );
  }

  const verified = await verifyFinalReportToken(token);
  if (!verified.ok) {
    return errorPage(
      verified.reason === "expired"
        ? "This link has expired"
        : "This link is no longer valid",
      verified.reason === "expired"
        ? "For your security, download links expire. You can still open the package from your portal."
        : "We could not open this link. It may have been replaced by a newer one.",
      410,
    );
  }

  const { scope } = verified;

  // Re-read the documents at click time rather than trusting anything on the
  // token: a package that was deleted or replaced after the email went out must
  // not still be downloadable.
  const { data: docs, error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, file_name, file_url")
    .in("id", scope.docIds)
    .eq("doc_type", FINAL_REPORT_DOC_TYPE)
    .order("created_at", { ascending: true });

  if (error) {
    logger.error("[FinalReport download] read failed:", error.message);
    return errorPage(
      "Something went wrong",
      "We could not load your documents just now. Please try again shortly.",
      500,
    );
  }

  const available = (docs ?? []).filter((d) => Boolean(d.file_url));
  if (available.length === 0) {
    return errorPage(
      "This package is no longer available",
      "The document this link pointed at has been removed. Please contact us and we will re-send it.",
      410,
    );
  }

  const firm = getFirm(await getLeadFirmKey(scope.leadIds[0] ?? null));

  // ── One document: serve the bytes ──
  // A link that covers exactly ONE document IS that document: a page whose
  // entire content is a single button is an interstitial, not a step. The
  // listing below is for the genuinely multi-document package, where the client
  // does have something to choose between.
  const targetId = docId ?? (available.length === 1 ? available[0].id : null);
  if (targetId) {
    // The token's own list is the authorisation — never the query string alone.
    if (!isUuid(targetId) || !scope.docIds.includes(targetId)) {
      return errorPage(
        "This link is no longer valid",
        "That document is not part of this package.",
        403,
      );
    }
    const doc = available.find((d) => d.id === targetId);
    if (!doc) {
      return errorPage(
        "This package is no longer available",
        "The document this link pointed at has been removed. Please contact us and we will re-send it.",
        410,
      );
    }

    const fileUrl = doc.file_url as string;
    const filename = (doc.file_name || "final-report.pdf").replace(/["\\\r\n]/g, "");

    // A public blob is already a CDN-served file — hand the browser straight to
    // it, so a 30 MB package never streams through this function. Blob serves it
    // inline by default, which is exactly what we want here; its ?download=1 is
    // added ONLY for the explicit save link. Only a private blob, which the
    // browser cannot read on its own, is proxied.
    if (!isPrivateBlobUrl(fileUrl)) {
      const direct = new URL(fileUrl);
      if (forceDownload) direct.searchParams.set("download", "1");
      else direct.searchParams.delete("download");
      return NextResponse.redirect(direct.toString(), 302);
    }

    try {
      const result = await get(fileUrl, {
        access: "private",
        token: blobTokenForUrl(fileUrl),
      });
      if (!result?.stream) {
        return errorPage(
          "This package is no longer available",
          "The document this link pointed at could not be found.",
          410,
        );
      }
      const headers = new Headers();
      const contentType = result.blob?.contentType || "application/octet-stream";
      headers.set("Content-Type", contentType);
      if (result.blob?.size != null) {
        headers.set("Content-Length", String(result.blob.size));
      }
      // Inline so the report renders in the browser, the same as the public
      // branch above — unless the save link was used, or the type is not one we
      // will render from our own origin (see INLINE_SAFE_TYPES).
      const inlineSafe = INLINE_SAFE_TYPES.has(
        contentType.split(";")[0].trim().toLowerCase(),
      );
      const disposition = !forceDownload && inlineSafe ? "inline" : "attachment";
      headers.set(
        "Content-Disposition",
        `${disposition}; filename="${filename}"`,
      );
      // Never let a browser render an unexpected type as something else.
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cache-Control", "private, no-store");
      return new Response(result.stream as ReadableStream, { status: 200, headers });
    } catch (err) {
      logger.error("[FinalReport download] blob read failed:", err);
      return errorPage(
        "Something went wrong",
        "We could not fetch your document just now. Please try again shortly.",
        500,
      );
    }
  }

  // ── Several documents: list what this link covers ──
  // Only reached by a multi-document package now. Each row opens the file in
  // the browser (target=_blank so the client keeps this list to come back to),
  // with the save link beside it for anyone who wants the file on disk.
  const items = available
    .map((d) => {
      const href = `${origin}/api/final-report/download?token=${encodeURIComponent(
        token,
      )}&doc=${encodeURIComponent(d.id)}`;
      return (
        `<li><div class="name">${escapeHtml(d.file_name || "Final report")}</div>` +
        `<a class="btn" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open</a>` +
        `<a class="save" href="${escapeHtml(href)}&amp;dl=1">Download</a></li>`
      );
    })
    .join("");

  return page({
    firmName: firm.label,
    logoSrc: `${origin}${firm.logoPath}`,
    heading: "Your final reporting package",
    body:
      `<p>Your closing is complete. The ${available.length} documents below make up ` +
      `your final reporting package. Please save them for your records.</p>` +
      `<ul>${items}</ul>` +
      `<p class="foot">These documents are also in the Documents section of your ` +
      `<a href="${escapeHtml(portalUrl())}/login">client portal</a>, where they stay available permanently.</p>`,
  });
}
