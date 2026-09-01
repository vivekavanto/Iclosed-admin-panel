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
 * the SAME database, so the keys and the legal names must not drift.
 */

/** The stored value of `leads.firm_key`. */
export type FirmKey = "navawilson" | "iclosed";

/**
 * The firm a lead belongs to when nothing says otherwise.
 *
 * Nava Wilson, because it is what every file was BEFORE this feature existed:
 * the shipped email lockup is the "iClosed — powered by Nava Wilson" artwork
 * and the retainer already named Nava Wilson PC. Defaulting anywhere else would
 * silently re-brand every live file the moment this deployed.
 *
 * The intake form is still shared between the firms, so new leads land here too
 * until intake URLs are split per firm.
 */
export const DEFAULT_FIRM_KEY: FirmKey = "navawilson";

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
    fromEnvVar: "RESEND_FROM_EMAIL_NAVAWILSON",
    replyToEnvVar: "RESEND_REPLY_TO_EMAIL_NAVAWILSON",
  },
  iclosed: {
    key: "iclosed",
    label: "iClosed LLP",
    legalName: "iClosed LLP",
    introName: "iClosed LLP",
    fromEmail: "iClosed <support@iclosed.ca>",
    replyToEmail: "support@iclosed.ca",
    // The bare iClosed wordmark. Intentionally NOT email-logo.png — that
    // lockup carries the "POWERED BY NAVA WILSON" tagline, which is exactly
    // what an iClosed LLP email must not say. Note the artwork reads
    // "iClosed", not "iClosed LLP"; the entity is spelled out in the copy.
    logoPath: "/logo.png",
    logoWidth: 60,
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
 * NULL is expected and normal: rows written before the firm_key column existed,
 * and any row the backfill has not reached, both read as null. They are Nava
 * Wilson files — see DEFAULT_FIRM_KEY.
 */
export function resolveFirmKey(value: unknown): FirmKey {
  return isFirmKey(value) ? value : DEFAULT_FIRM_KEY;
}

/** The profile for a firm key, tolerating null/garbage. */
export function getFirm(value: unknown): FirmProfile {
  return FIRMS[resolveFirmKey(value)];
}
