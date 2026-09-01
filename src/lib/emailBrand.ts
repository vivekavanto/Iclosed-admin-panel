import { escapeHtml } from "./renderEmailTemplate";
import { getFirm, type FirmKey, type FirmProfile } from "./firms";

/**
 * Re-brand a rendered email body for the firm the file belongs to.
 *
 * ── Why this is a POST-RENDER REWRITE and not a template placeholder ────
 * The brand lockup is not injected by any send code: it is a literal
 * `<img src="https://<admin-host>/email-logo.png" width="85" …>` sitting in the
 * HTML of every `email_templates` row (see the 2026-08-26 email-logo
 * migrations), and those rows live in the database SHARED with the customer
 * portal.
 *
 * That rules out the obvious fix. Swapping the tag for a `{{ brand_logo }}`
 * placeholder would take effect the instant the migration ran — including on
 * every deploy and every send path that had not yet learned to resolve the new
 * token, where it would reach clients as the literal text "{{ brand_logo }}".
 * Rewriting the img AFTER the template renders needs no migration at all: the
 * rows keep working untouched on any build, old or new, and an admin editing a
 * template in Admin → Templates → Emails cannot break the firm branding as long
 * as they leave the logo image in place.
 *
 * The `{{ brand_logo }}` / `{{ firm_name }}` tokens ARE supported here as well,
 * so a template written from now on can place the lockup deliberately. They are
 * simply not required.
 *
 * ── What gets rewritten, and what does not ──────────────────────────────
 * Only the src FILENAME and the width. The origin in the template's src is left
 * exactly as it is, because both apps render these same rows and the images are
 * served by the admin app — so the portal's mirror of this function
 * (iclosed_dev_web/src/lib/emailBrand.ts) does the identical rewrite without
 * needing to know the admin app's public URL. There is no env var to keep in
 * step and no way for one repo to point the logo at its own host by mistake.
 *
 * The width has to move with the filename: the two firms' artwork is cropped
 * very differently, so a shared width renders the wordmark at two different
 * sizes. See FirmProfile.logoWidth for the arithmetic. Everything else on the
 * tag — style, alt, the wrapper the 2026-08-26 migration so carefully placed it
 * in — survives untouched.
 *
 * Apply this to the final HTML immediately before handing it to Resend.
 */

/** Absolute origin of this app — an email cannot resolve a relative src. */
export function brandBaseUrl(): string {
  const explicit = process.env.ADMIN_PORTAL_URL || process.env.NEXT_PUBLIC_ADMIN_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/** Absolute URL of a firm's email lockup, for templates that have no img yet. */
export function firmLogoUrl(firm: FirmKey | FirmProfile | null | undefined): string {
  return `${brandBaseUrl()}${profileOf(firm).logoPath}`;
}

function profileOf(firm: FirmKey | FirmProfile | null | undefined): FirmProfile {
  return typeof firm === "object" && firm !== null ? firm : getFirm(firm);
}

/** Every `<img …>` in the body. Which of them is the logo is decided below. */
const IMG_TAG_RE = /<img\b[^>]*>/gi;

/**
 * The filenames that count as "the brand lockup" in a template's src:
 * `email-logo.png` (Nava Wilson) and `logo.png` (iClosed LLP), plus any older
 * `email-logo-<something>.png`. Keep in step with FIRMS[...].logoPath.
 *
 * The ["'/] before the filename is load-bearing. Without it an unrelated asset
 * that merely ENDS in "logo.png" - a partner's `brokerage-logo.png`, say -
 * would match and be silently replaced with this firm's lockup.
 *
 * Written as a regex LITERAL on purpose. Assembling it from the registry with
 * `new RegExp` needs every backslash doubled, and getting that wrong yields a
 * pattern that quietly matches NOTHING: no error, no failed send, just every
 * email going out carrying the other firm's logo.
 */
const LOGO_SRC_RE =
  /(<img\b[^>]*\bsrc\s*=\s*["'][^"']*?["'\/])(?:email-logo(?:-[a-z0-9]+)?|logo)\.png/i;

/** The tokens a template may use to place the lockup itself. */
const LOGO_TOKEN_RE = /\{\{\s*(?:brand_logo|firm_logo|logo)\s*\}\}/gi;

/** The tokens a template may use to name the firm in prose. */
const FIRM_NAME_TOKEN_RE = /\{\{\s*(?:firm_name|firm_legal_name|firm)\s*\}\}/gi;

/**
 * Point one `<img>` tag at `profile`'s lockup, at `profile`'s width.
 *
 * The width is carried in two places and BOTH must move together — the HTML
 * attribute is what Outlook reads, the inline style is what everything else
 * reads. Updating one and not the other leaves the logo at its old size in
 * exactly the clients you were not looking at. (Same trap the 2026-08-26
 * email-logo-size migration documents.)
 */
function rebrandImgTag(tag: string, profile: FirmProfile): string {
  const fileName = profile.logoPath.replace(/^.*\//, "");
  const w = profile.logoWidth;
  return tag
    .replace(LOGO_SRC_RE, (_m, head: string) => `${head}${fileName}`)
    .replace(/(\s)width\s*=\s*["']\d+["']/i, `$1width="${w}"`)
    // The leading boundary is load-bearing: without it this also matches the
    // tail of `max-width:600px` and rewrites the wrong declaration.
    .replace(/(^|[;"'\s])width\s*:\s*\d+px/gi, `$1width:${w}px`)
    // `max-width:100%` is left alone — only a px cap needs to follow the width.
    .replace(/max-width\s*:\s*\d+px/gi, `max-width:${w}px`);
}

/**
 * Rewrite a rendered email body for `firm`.
 *
 * Safe to call on a body with no logo, on one already branded for the right
 * firm, and on one branded for the wrong firm — all three converge on the same
 * output.
 */
export function brandEmailHtml(
  html: string,
  firm: FirmKey | FirmProfile | null | undefined,
): string {
  if (!html) return html;

  const profile = profileOf(firm);

  return html
    .replace(IMG_TAG_RE, (tag) =>
      LOGO_SRC_RE.test(tag) ? rebrandImgTag(tag, profile) : tag,
    )
    // A template that asks for the lockup by name gets the standard tag.
    .replace(
      LOGO_TOKEN_RE,
      `<img src="${firmLogoUrl(profile)}" alt="${escapeHtml(profile.legalName)}" width="${profile.logoWidth}" style="width:${profile.logoWidth}px;max-width:${profile.logoWidth}px;height:auto;border:0;" />`,
    )
    .replace(FIRM_NAME_TOKEN_RE, escapeHtml(profile.legalName));
}
