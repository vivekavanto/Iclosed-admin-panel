// Tells the client the closing-funds task is now waiting for them.
//
// Fired by the admin's "Activate task & notify client" button — never on a
// schedule and never at conversion, because the task only becomes answerable
// once the firm has drawn up the Final Statement of Account and the admin has
// entered the balance due.
//
// ONE email to everyone on the file, with every address in `to`. The balance is
// a property of the file, not of each purchaser, so three co-purchasers getting
// three identical copies would read as a mistake — the same convention
// sendFinalReportEmail and the combined milestone email follow.
//
// TWO attachments ride along: the Final Statement of Account (per-file, pulled
// from Vercel Blob) and the firm's static Funds Transfer Instructions PDF. Both
// are also reachable from the task itself, but a client reading the email on
// their phone should not have to log in to see what they owe or how to pay it.
//
// Wording lives in the "Deposit Funds Task Added" row of `email_templates` so
// staff can retune it without a deploy. Unlike the final-report sender, a
// missing or inactive row does NOT block the send: this email is the only thing
// telling a purchaser that money is due before closing, so it falls back to the
// built-in copy below rather than going quiet.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { get } from "@vercel/blob";
import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { isPrivateBlobUrl, blobTokenForUrl } from "./blobPrivacy";
import { sendEmail } from "./email/emailTransport";
import { getLeadFirmKey } from "./leadFirm";
import { brandEmailHtml } from "./emailBrand";
import { formatCurrency } from "./formatCurrency";
import { buildLeadAddressForEmail } from "./leadEmailAddress";
import {
  decodeTemplateBraces,
  renderTemplateSafe,
  type TemplateValue,
} from "./renderEmailTemplate";

/** `email_templates.name` that owns the wording. Substring, case-insensitive. */
export const DEPOSIT_TASK_TEMPLATE_NAME = "Deposit Funds Task Added";

export interface DepositTaskEmailResult {
  /** Addresses the mail actually went to. */
  sent: string[];
  /** Why nothing went out, when nothing did. */
  error?: string;
}

/**
 * What a recipient needs. The address columns are here because
 * buildLeadAddressForEmail reads them off the lead — see
 * DEPOSIT_TASK_LEAD_COLUMNS for the matching select.
 */
interface RecipientLead {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  lead_type: string | null;
  parent_lead_id: string | null;
  co_person_role: string | null;
  address_street: string | null;
  address_city: string | null;
  address_province: string | null;
  address_postal_code: string | null;
  selling_address_street: string | null;
  selling_address_city: string | null;
  selling_address_province: string | null;
  selling_address_postal_code: string | null;
}

/**
 * One unbroken string literal on purpose: Supabase's typed client parses the
 * select at the type level, and a `+`-concatenated version is not a literal —
 * every row then infers as GenericStringError.
 */
export const DEPOSIT_TASK_LEAD_COLUMNS =
  "id, first_name, last_name, email, lead_type, parent_lead_id, co_person_role, address_street, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code";

/** "Alice" / "Alice and Bob" / "Alice, Bob and Carol". */
function joinNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/** Pull a stored document's bytes, whichever blob store it lives in. */
async function downloadDoc(fileUrl: string): Promise<Buffer> {
  if (isPrivateBlobUrl(fileUrl)) {
    const result = await get(fileUrl, {
      access: "private",
      token: blobTokenForUrl(fileUrl),
    });
    if (!result?.stream) throw new Error("private blob not found");
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The firm's Funds Transfer Instructions, attached to every one of these emails.
 *
 * A file on disk rather than a blob or a template row: it is the same document
 * for every client, it carries the firm's letterhead, and it must not be
 * editable from an admin form — the trust-account numbers inside it are the
 * same ones `FUNDS_TRANSFER` (depositTask.ts) renders on the task, and there
 * should be exactly one way to change either.
 *
 * Kept OUT of `public/` deliberately: served from there it would be a
 * guessable, unauthenticated URL exposing the firm's banking details. It lives
 * under `assets/` and is pulled into the deployed bundle by
 * `outputFileTracingIncludes` in next.config.ts — if that entry is dropped, the
 * read below fails on Vercel and the email quietly goes out with one attachment
 * instead of two.
 */
const INSTRUCTIONS_FILE = "funds-transfer-instructions.pdf";

/** What the client sees the attachment called. */
const INSTRUCTIONS_ATTACHMENT_NAME = "Funds Transfer Instructions.pdf";

async function loadTransferInstructions(): Promise<Buffer> {
  return readFile(path.join(process.cwd(), "assets", INSTRUCTIONS_FILE));
}

/**
 * Where the email's CTA sends the client: their task list.
 *
 * NEXT_PUBLIC_CUSTOMER_PORTAL_URL is the variable the rest of this app already
 * uses for the customer portal (see convertLead's auth-callback links), with the
 * same default. Do not invent another name for it — an unset variable here means
 * a dead link in the one email telling a purchaser that money is due.
 *
 * /dashboard rather than the bare root: the portal's middleware protects that
 * path and redirects a logged-out visitor to /login?next=/dashboard, so a client
 * lands on the task itself either way.
 */
export function portalUrl(): string {
  const DEFAULT = "https://www.iclosed.ca";
  // `??` alone is not enough: an env var set to "" or whitespace is not null, so
  // it would win the fallback and leave a RELATIVE href ("/dashboard"), which
  // every mail client treats as unclickable. Same for a value with no scheme.
  const configured = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "").trim();
  let base = configured || DEFAULT;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return `${base.replace(/\/+$/, "")}/dashboard`;
}

/**
 * Built-in wording, used when the template row is missing, inactive or empty.
 * Deliberately says the same thing the seeded row says — a client must never be
 * able to tell which one they got.
 */
function fallbackBody(v: Record<string, string>): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi ${v.client_names},</p>
  <p>
    Please see attached your Final Statement of Account, along with instructions
    on how to deposit funds into our trust account. Once you&rsquo;ve deposited,
    <strong>please log into iClosed to upload your proof of deposit.</strong>
  </p>
  <p style="margin:0 0 4px;"><strong>Balance due on closing:</strong> ${v.balance_due}</p>
  <p style="margin:0 0 4px;"><strong>Property:</strong> ${v.property_address}</p>
  <p style="margin:0 0 4px;"><strong>Closing date:</strong> ${v.closing_date}</p>
  <p style="margin-top:24px;">
    <a href="${v.portal_url}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open iClosed
    </a>
  </p>
</div>`;
}

/**
 * `deals.closing_date` is a DATE: parsing it as a JS Date gives UTC midnight,
 * which renders as the previous day in any negative-offset timezone. Format the
 * Y/M/D parts explicitly instead.
 */
function formatClosingDate(raw: string | null | undefined): string {
  if (!raw) return "TBD";
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(raw);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export async function sendDepositTaskEmail(opts: {
  /** Everyone on the file, primary first. */
  leads: RecipientLead[];
  fileNumber: string | null;
  closingDate: string | null;
  balanceDue: number | null;
  /** The Final Statement of Account, attached alongside the instructions PDF. */
  statement: { file_name: string | null; file_url: string | null } | null;
}): Promise<DepositTaskEmailResult> {
  const ordered = [...(opts.leads ?? [])]
    .filter((l) => (l.email ?? "").trim())
    .sort((a, b) => (a.parent_lead_id ? 1 : 0) - (b.parent_lead_id ? 1 : 0));

  if (ordered.length === 0) {
    return { sent: [], error: "No client on this file has an email address." };
  }

  const emails = ordered.map((l) => (l.email ?? "").trim());
  // A co-client sharing their partner's inbox would otherwise be listed twice.
  const to = Array.from(new Set(emails.map((e) => e.toLowerCase()))).map(
    (lower) => emails.find((e) => e.toLowerCase() === lower) as string,
  );

  if (!process.env.RESEND_API_KEY) {
    return { sent: [], error: "Email is not configured (RESEND_API_KEY missing)." };
  }

  const anchor = ordered[0];
  const values: Record<string, string> = {
    client_name: joinNames(ordered.map((l) => (l.first_name ?? "").trim())),
    client_names: joinNames(
      ordered.map((l) => `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim()),
    ),
    first_name: joinNames(ordered.map((l) => (l.first_name ?? "").trim())),
    "user.first_name": joinNames(ordered.map((l) => (l.first_name ?? "").trim())),
    balance_due: formatCurrency(opts.balanceDue),
    property_address: await buildLeadAddressForEmail(anchor),
    lead_address: await buildLeadAddressForEmail(anchor),
    closing_date: formatClosingDate(opts.closingDate),
    file_number: opts.fileNumber ?? "",
    portal_url: portalUrl(),
  };

  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    if (!Object.prototype.hasOwnProperty.call(values, key)) return null;
    // Everything here is client-supplied, so it is all HTML-escaped.
    return { value: values[key] };
  };

  const { data: templates } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .ilike("name", `%${DEPOSIT_TASK_TEMPLATE_NAME}%`)
    .order("created_at", { ascending: false });
  const template = (templates ?? []).find((t) => t.is_active && !t.is_deleted && t.body);

  const html = template
    ? renderTemplateSafe(decodeTemplateBraces(template.body), resolve)
    : fallbackBody(values);
  const subject = renderTemplateSafe(
    decodeTemplateBraces(
      template?.subject ||
        "New task added on iClosed — Deposit Funds Into Our Trust Account",
    ),
    resolve,
    { escape: false },
  );

  // Both attachments are best-effort: the task itself links the statement and
  // renders the transfer instructions inline, so an email that loses one still
  // tells the client what to do. A failure here must not stop the send.
  const attachments: Array<{ filename: string; content: Buffer }> = [];
  if (opts.statement?.file_url) {
    try {
      attachments.push({
        filename: opts.statement.file_name || "statement-of-account.pdf",
        content: await downloadDoc(opts.statement.file_url),
      });
    } catch (err) {
      logger.warn("[DepositTask] statement attach failed — sending without it:", err);
    }
  }
  try {
    attachments.push({
      filename: INSTRUCTIONS_ATTACHMENT_NAME,
      content: await loadTransferInstructions(),
    });
  } catch (err) {
    logger.warn(
      "[DepositTask] transfer-instructions attach failed — check outputFileTracingIncludes:",
      err,
    );
  }

  // `ordered` is primary-first, and the firm is a property of the file, so
  // any lead in it resolves to the same answer.
  const firm = await getLeadFirmKey(ordered[0]?.id ?? null);

  // This used to await resend.emails.send() and discard its { data, error },
  // then `return { sent: to }` unconditionally — so a refused send was reported
  // as delivered, with the statement and transfer instructions never arriving.
  const result = await sendEmail(
    {
      to,
      subject,
      html: brandEmailHtml(html, firm),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    { firm, label: "deposit-task" },
  );

  if (!result.ok) {
    logger.error(`[DepositTask] send failed for ${to.length} recipient(s): ${result.error}`);
    return { sent: [], error: result.error };
  }

  return { sent: to };
}
