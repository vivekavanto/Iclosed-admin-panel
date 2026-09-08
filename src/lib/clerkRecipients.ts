// WHO the clerk emails are addressed to — both of them: the document package
// ("Email to Clerk") and the proof-of-deposit alert.
//
// Split out of sendClerkDocumentsEmail.ts and kept dependency-free on purpose.
// A wrong address here does not fail loudly: it delivers a client's whole
// document package — identification, agreements, personal information — to
// somebody who should not have it, and the send is audited as a success. So the
// rules live in one file with no imports, which is what lets tests/
// clerkRecipients.test.ts pin them (the sender itself pulls in Supabase, the
// email transport and the PDF builder, none of which a test can load).
//
// The firm's addresses, and the rule each one follows:
//
//   Purchase        → iclosed.purchase@navawilson.law   (CLERK_PURCHASE_EMAIL)
//   Sale            → iclosed.sale@navawilson.law       (CLERK_SALE_EMAIL)
//   Purchase & Sale → BOTH of the above, on ONE email
//   EVERY file      → aliya@navawilson.law as well      (CLERK_ALWAYS_EMAIL)
//
// The proof-of-deposit alert adds bookkeeping@navawilson.law on top of that
// (DEPOSIT_BOOKKEEPING_EMAIL) — money reaching the trust account is their record
// to keep, not the clerk's.
//
// Every one of them is an environment override with a shipped default, so an
// address can be changed without a deploy — and so a STALE override silently
// wins over the defaults above. If mail is reaching the wrong inbox, read the
// environment before reading this file.

/** Firm defaults; override per-environment without a deploy. */
export const DEFAULT_PURCHASE_CLERK = "iclosed.purchase@navawilson.law";
export const DEFAULT_SALE_CLERK = "iclosed.sale@navawilson.law";

/**
 * Copied on every file of the documents email, whichever side it is — including
 * the types that resolve to no side clerk at all. Override with
 * CLERK_ALWAYS_EMAIL (comma-separated); set it to "off" to drop it.
 *
 * Kept separate from the two side lists rather than baked into both, so an
 * environment that overrides CLERK_PURCHASE_EMAIL / CLERK_SALE_EMAIL does not
 * silently lose it.
 */
export const DEFAULT_ALWAYS_CLERK = "aliya@navawilson.law";

function splitAddresses(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The supervising address copied on every file, or [] when it is switched off.
 *
 * Kept in one place because two callers read it and they must not drift apart.
 */
export function alwaysClerkRecipients(): string[] {
  const configured = (process.env.CLERK_ALWAYS_EMAIL ?? DEFAULT_ALWAYS_CLERK).trim();
  if (!configured || configured.toLowerCase() === "off") return [];
  return splitAddresses(configured);
}

/**
 * Which clerk inbox(es) this file belongs to.
 *
 * Matches the same "combined means both" rule as formatLeadTypeLabel: anything
 * naming both purchase and sale is a P&S file. A type we don't recognise
 * (Refinance, blank) returns [] and the caller refuses to send rather than
 * guessing an inbox.
 *
 * SHARED with the deposit-proof email (sendDepositProofEmail.ts). Widening this
 * changes who is told that a client's closing funds arrived, so the documents
 * email reads clerkDocumentRecipients() below instead of relaxing this.
 */
export function clerkRecipientsForType(rawType: string | null | undefined): string[] {
  const purchase = splitAddresses(process.env.CLERK_PURCHASE_EMAIL || DEFAULT_PURCHASE_CLERK);
  const sale = splitAddresses(process.env.CLERK_SALE_EMAIL || DEFAULT_SALE_CLERK);
  const always = alwaysClerkRecipients();

  const lt = (rawType ?? "").toLowerCase().trim();
  const hasPurchase = lt.includes("purchase");
  const hasSale = lt.includes("sale");

  // The Set dedupes an address that appears on both sides AND in `always`, so a
  // Purchase & Sale file still mails each person once.
  if (hasPurchase && hasSale) return Array.from(new Set([...purchase, ...sale, ...always]));
  if (hasSale) return Array.from(new Set([...sale, ...always]));
  if (hasPurchase) return Array.from(new Set([...purchase, ...always]));
  return [];
}

/**
 * Who the DOCUMENTS email goes to for a file of the given type.
 *
 * The side clerks exactly as clerkRecipientsForType() resolves them — which
 * already includes the always-address — except that a file whose side we cannot
 * name (Refinance, blank) falls back to the always-address instead of [].
 *
 * That fallback is the whole difference between the two functions, and it only
 * belongs here. "One address sees every file" is the rule the firm gave for the
 * document package; a Refinance used to be the one file type that address never
 * saw, and an admin had no way to email its documents to anyone. The deposit
 * proof keeps the stricter rule: "the closing funds have arrived" on a file with
 * no purchase or sale side is a message nobody asked for, and staying silent
 * there is the safer default.
 */
export function clerkDocumentRecipients(rawType: string | null | undefined): string[] {
  const sides = clerkRecipientsForType(rawType);
  return sides.length > 0 ? sides : alwaysClerkRecipients();
}

/**
 * The CLERK_DOCUMENTS_EMAIL override, or null when it is unset.
 *
 * Comma-separated, and deliberately NOT merged with the per-type lists: the
 * point of it is to say "these addresses and no others" for an environment.
 * Returning null (rather than []) for a blank value is what lets the caller
 * tell "not configured" from "configured as this list", so an unset variable
 * falls through to clerkDocumentRecipients() untouched.
 *
 * Read ONLY by the documents email. The deposit-proof email has its own
 * equivalent (DEPOSIT_PROOF_EMAIL) for the same reason.
 */
export function clerkDocumentsOverride(): string[] | null {
  const raw = (process.env.CLERK_DOCUMENTS_EMAIL ?? "").trim();
  if (!raw) return null;
  const list = splitAddresses(raw);
  return list.length > 0 ? list : null;
}

// ── Proof of deposit ────────────────────────────────────────────────────────
// The "client sent their closing funds" alert. Same clerk routing as above,
// plus bookkeeping.

/**
 * Copied on every proof-of-deposit alert. Override with
 * DEPOSIT_BOOKKEEPING_EMAIL (comma-separated); "off" drops it.
 */
export const DEFAULT_BOOKKEEPING = "bookkeeping@navawilson.law";

export function bookkeepingRecipients(): string[] {
  const configured = (process.env.DEPOSIT_BOOKKEEPING_EMAIL ?? DEFAULT_BOOKKEEPING).trim();
  if (!configured || configured.toLowerCase() === "off") return [];
  return splitAddresses(configured);
}

/**
 * Who the proof-of-deposit alert goes to.
 *
 * The side's clerk (which already carries the always-address) plus bookkeeping,
 * so a Purchase file reaches iclosed.purchase@, aliya@ and bookkeeping@.
 *
 * DEPOSIT_PROOF_EMAIL wins outright when set — it is not merged with either
 * list, because the point of it is to say "these addresses and no others" for an
 * environment. "off" disables the email entirely (no recipients means the caller
 * returns `no_recipients` without sending), which is how a preview deployment
 * stops mailing real staff.
 *
 * Unlike the document package this does NOT fall back to the always-address on a
 * file with no purchase or sale side: telling a supervisor that closing funds
 * arrived on a refinance is a message nobody asked for. Bookkeeping still gets
 * it — the money did move.
 */
export function depositProofRecipients(dealType: string | null | undefined): string[] {
  const override = (process.env.DEPOSIT_PROOF_EMAIL ?? "").trim();
  if (override) {
    return override.toLowerCase() === "off" ? [] : dedupe(splitAddresses(override));
  }
  return dedupe([...clerkRecipientsForType(dealType), ...bookkeepingRecipients()]);
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list));
}
