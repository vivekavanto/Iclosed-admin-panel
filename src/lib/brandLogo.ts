// The iClosed brand lockup, as it appears in the footer of every email.
//
// ONE asset, three consumers, and they must not drift:
//
//   • email templates  — an <img> in the email_templates rows pointing at
//                        https://<admin-host>/email-logo.png (see the
//                        2026-08-26 email-logo migrations). This is why the
//                        file has to stay in `public/`.
//   • packagePdf.ts    — the deal package emailed to the clerks (server, pdf-lib)
//   • dealPdf.ts       — the same document downloaded from the deal page
//                        (browser, jsPDF)
//
// The portal keeps its own copy for the retainer agreement
// (iclosed_dev_web/public/logo-full.png) because that PDF is generated over
// there; if this file is ever replaced, replace that one too.
//
// The numbers below are MEASURED from the PNG, not guessed, and the drawing
// code depends on them. Re-measure if the artwork is ever re-cropped.

// ── TWO FIRMS, TWO LOCKUPS ──────────────────────────────────────────────
// The constants below describe the NAVA WILSON lockup — the iClosed wordmark
// over "POWERED BY NAVA WILSON". A file on the iClosed LLP side uses the bare
// wordmark in public/logo.png instead; see FIRMS in src/lib/firms.ts, and
// emailBrand.ts for how a rendered email is repointed at it.
//
// The PDF consumers below are NOT firm-aware yet: the deal package is an
// internal document for the clerks, so it stays on the one lockup. The
// client-facing PDFs that DO follow the firm are the retainer (portal,
// generateRetainerPdf.ts) and the closing-cost statement, which has carried
// its own per-firm letterhead in closing_cost_config.logo_url since 2026-08-05.
//
/** Served by this app; also the URL burned into the email template rows. */
export const BRAND_LOGO_URL = "/email-logo.png";

/** Path under the repo root, for server-side reads. */
export const BRAND_LOGO_FILE = "public/email-logo.png";

/** Intrinsic pixel size of the artwork. */
export const BRAND_LOGO_PX = { w: 1108, h: 480 } as const;

/**
 * How much of the image's HEIGHT the "iClosed" wordmark occupies (rows 77-274
 * of 480). The rest is the "POWERED BY NAVA WILSON" tagline plus generous
 * built-in whitespace — 16% above the ink and 21% below it. Sizing the lockup
 * as if it were a tight wordmark crop is what makes it come out half-size.
 */
export const BRAND_LOGO_WORDMARK_FRACTION = 0.4125;

/** Top of the ink as a fraction of the image height (row 77 of 480). */
export const BRAND_LOGO_INK_TOP_FRACTION = 77 / 480;

/**
 * Header geometry for the deal package's running chrome, shared by the pdf-lib
 * and jsPDF renderers so the emailed copy and the downloaded copy are the same
 * document.
 *
 * These replace a 12pt Helvetica-Bold "iClosed" whose cap height was ~8.6pt.
 * At LOGO_H the wordmark measures 21 * 0.4125 = 8.7pt, and LOGO_TOP is chosen
 * so the wordmark's cap top lands on the same 47.4pt-from-page-top line the
 * text sat on. Ink bottom then falls at ~60.7pt, clear of the 68pt rule.
 */
export const BRAND_LOGO_HEADER = {
  /** Drawn height in points. */
  height: 21,
  /** Drawn width in points, preserving the aspect ratio. */
  get width() {
    return (BRAND_LOGO_PX.w / BRAND_LOGO_PX.h) * this.height;
  },
  /** Distance from the top of the page to the top edge of the drawn image. */
  top: 44,
} as const;
