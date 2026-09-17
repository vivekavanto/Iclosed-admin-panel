/**
 * The two law firms this app sends mail and papers retainers on behalf of.
 *
 * iClosed serves clients under two entities. Which one a file belongs to is a
 * PER-FILE label (`leads.firm_key`, see leadFirm.ts) chosen by an admin on the
 * lead, and it drives three client-visible things:
 *
 *   • the address every automated email is sent FROM (and replied to)
 *   • the brand lockup at the foot of every email
 *   • the retainer agreement's logo and its wording
 *
 * Everything else — the intake URL, the portal, the file number, the task
 * templates — is shared. This is a branding split, not a tenancy split.
 *
 * ── Why the keys are 'navawilson' / 'iclosed' ───────────────────────────
 * They are the SAME keys `closing_cost_config.firm_key` already uses for the
 * closing-cost statement letterhead (2026-08-03-closing-cost-firms-and-
 * statement-types.sql). Reusing them means a file's email branding and its
 * statement letterhead can be reconciled by key without a mapping table, and
 * an admin never has to learn two vocabularies for the same two firms.
 *
 * The tables stay separate on purpose: closing_cost_config carries FEE
 * SCHEDULES and a Blob-hosted statement letterhead maintained in Settings →
 * Closing Costs, which is a different lifecycle from the email identity below.
 *
 * ── Mirror in the portal ────────────────────────────────────────────────
 * `iclosed_dev_web/src/lib/firms.ts` is the same registry, because the retainer
 * agreement is rendered over there. The two files read `leads.firm_key` out of
 * the SAME database, so the keys, the legal names AND DEFAULT_FIRM_KEY must not
 * drift — a lookup that fails in one repo would otherwise brand the file
 * differently from the other.
 */

/** The stored value of `leads.firm_key`. */
export type FirmKey = "navawilson" | "iclosed";

/**
 * The firm a lead belongs to when nothing says otherwise.
 *
 * iClosed LLP since 2026-09-08. It was 'navawilson' — what every file was before
 * the split — and the files created under that default KEEP it. Nothing is
 * re-branded by this constant changing, because nothing reads it for a stored
 * file: leads.firm_key is NOT NULL with a CHECK constraint, so every existing
 * row already says which firm it is. This value decides two other things:
 *
 *   • what an UNRECOGNISED value resolves to (resolveFirmKey below), and
 *   • what a FAILED lookup falls back to (leadFirm.ts — a deleted lead, a
 *     database error). Those used to land on Nava Wilson; they now land on
 *     iClosed LLP.
 *
 * What actually stamps a NEW file is the database column default, because the
 * portal's intake insert does not name a firm — see
 * migrations/2026-09-08-default-firm-iclosed.sql. The two must be changed
 * together: moving only this constant would leave every new intake lead on
 * 'navawilson' while the code insisted the default was iClosed.
 */
export const DEFAULT_FIRM_KEY: FirmKey = "iclosed";

export interface FirmProfile {
  key: FirmKey;
  /** Short label for the admin toggle and internal lists. */
  label: string;
  /**
   * The legal entity, spelled as it must appear in client-facing prose —
   * the retainer's "I agree to retain ___" line, the binding-agreement FAQ.
   */
  legalName: string;
  /** How the firm introduces itself in the retainer's "Who are we?" answer. */
  introName: string;
  /** Resend `from`: display name + address. */
  fromEmail: string;
  /** Where a client's reply actually lands. */
  replyToEmail: string;
  /**
   * Brand lockup for emails, served by THIS app out of `public/` (absolute-ised
   * at send time — an email cannot resolve a relative src). See brandLogo.ts.
   */
  logoPath: string;
  /**
   * Rendered width of that lockup, in px, for the email `<img>`.
   *
   * Per-firm because the two files are cropped completely differently and a
   * single width would NOT look the same:
   *
   *     email-logo.png  1108x480  the wordmark is 41% of the height
   *     logo.png          90x29   the wordmark is 79% of the height
   *
   * At a shared 85px the bare wordmark would come out ~44% larger than the
   * same wordmark inside the lockup. The widths below are chosen so the word
   * "iClosed" measures the SAME in both firms' emails (~15px of ink):
   * 85 x 0.4125 x (480/1108) = 15.2px, and 60 x 0.79 x (29/90) = 15.3px.
   * Re-derive if either file is re-cropped.
   */
  logoWidth: number;
  /**
   * Brand lockup for the retainer PDF, read from THIS app's `public/` at send
   * time, plus the geometry to draw it at. MIRROR of FirmProfile.pdfLogo in
   * `iclosed_dev_web/src/lib/firms.ts` — the portal renders the same document
   * at signing, and the two must produce the same letterhead.
   *
   * `file` is the only field that legitimately differs between the repos: the
   * Nava Wilson lockup ships here as `email-logo.png` and in the portal as
   * `logo-full.png`. They are the SAME artwork, byte for byte, so every number
   * below carries over unchanged.
   *
   * The numbers are MEASURED, not guessed:
   *
   *     file                    size      wordmark is...  padding above/below
   *     email-logo.png          1108x480  41% of height   16% / 21%
   *     logo.png                  90x29   79% of height   14% /  7%
   *
   * `height` is chosen so the word "iClosed" measures the ~22pt it has rendered
   * at since this document existed; `lift` cancels that file's own built-in
   * whitespace so the ink starts on the same line either way; `gap` is what the
   * cursor advances by afterwards; `inkLeft` is the transparent padding on the
   * file's LEFT edge as a fraction of its width, which the renderer subtracts so
   * the wordmark lines up with the left margin instead of sitting right of it.
   *
   * Re-measure all four here AND in the portal if either file is re-cropped.
   */
  pdfLogo: {
    file: string;
    /** Drawn height, in points. */
    height: number;
    /** drawImage y = cursor - height + lift. */
    lift: number;
    /** Extra advance below the image, in points. */
    gap: number;
    /** Left transparent padding, as a fraction of the file's width. */
    inkLeft: number;
  };
  /** Env vars that override the two addresses per deployment. */
  fromEnvVar: string;
  replyToEnvVar: string;
}

export const FIRMS: Record<FirmKey, FirmProfile> = {
  navawilson: {
    key: "navawilson",
    label: "Nava Wilson",
    legalName: "Nava Wilson PC",
    introName: "iClosed, powered by Nava Wilson PC",
    fromEmail: "iClosed <iclosed@navawilson.law>",
    replyToEmail: "iclosed@navawilson.law",
    logoPath: "/email-logo.png",
    logoWidth: 85,
    // Ink starts at pixel 87 of 1108 across, 16% down. Same artwork the portal
    // ships as logo-full.png.
    pdfLogo: { file: "email-logo.png", height: 54, lift: 13, gap: 2, inkLeft: 87 / 1108 },
    fromEnvVar: "RESEND_FROM_EMAIL_NAVAWILSON",
    replyToEnvVar: "RESEND_REPLY_TO_EMAIL_NAVAWILSON",
  },
  iclosed: {
    key: "iclosed",
    label: "iClosed LLP",
    legalName: "iClosed LLP",
    introName: "iClosed LLP",
    fromEmail: "iClosed <hello@iclosed.ca>",
    replyToEmail: "support@iclosed.ca",
    // The bare iClosed wordmark. Intentionally NOT email-logo.png — that
    // lockup carries the "POWERED BY NAVA WILSON" tagline, which is exactly
    // what an iClosed LLP email must not say. Note the artwork reads
    // "iClosed", not "iClosed LLP"; the entity is spelled out in the copy.
    logoPath: "/logo.png",
    logoWidth: 60,
    // The same bare wordmark, and NOT email-logo.png, for the same reason: an
    // iClosed LLP retainer must not carry the "POWERED BY NAVA WILSON" tagline.
    // Ink starts at pixel 2 of 90 across.
    pdfLogo: { file: "logo.png", height: 28, lift: 8, gap: 16, inkLeft: 2 / 90 },
    fromEnvVar: "RESEND_FROM_EMAIL_ICLOSED",
    replyToEnvVar: "RESEND_REPLY_TO_EMAIL_ICLOSED",
  },
};

/** Every firm, in the order the admin toggle should list them. */
export const FIRM_KEYS: FirmKey[] = ["navawilson", "iclosed"];

/** True for a value that is a real firm key. */
export function isFirmKey(value: unknown): value is FirmKey {
  return typeof value === "string" && value in FIRMS;
}

/**
 * Coerce anything read out of the database (or off a request body) to a firm.
 *
 * NULL should no longer occur — the column is NOT NULL with a CHECK constraint —
 * but this stays tolerant because a lookup can still hand us undefined (a row
 * that was not selected, a deal with no lead). Anything unrecognised resolves to
 * DEFAULT_FIRM_KEY, which is iClosed LLP; a file that must be Nava Wilson says
 * so in its own column and never reaches this fallback.
 */
export function resolveFirmKey(value: unknown): FirmKey {
  return isFirmKey(value) ? value : DEFAULT_FIRM_KEY;
}

/** The profile for a firm key, tolerating null/garbage. */
export function getFirm(value: unknown): FirmProfile {
  return FIRMS[resolveFirmKey(value)];
}
