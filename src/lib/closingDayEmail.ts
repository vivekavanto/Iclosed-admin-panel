// "Your Closing Day Update" email: 9AM (office time) on the day a file closes.
//
// Run by GET /api/internal/closing-day-emails (Vercel Cron). Every deal whose
// closing_date (or, on a Purchase & Sale file, selling_closing_date) is TODAY in
// the office timezone emails the client on that deal. A family has one deal per
// person, so each person gets their own email addressed to them; Purchase and
// Sale clients are both covered because both sides carry their own deal.
//
// Vercel cron schedules are UTC and 9AM Toronto moves between 13:00 and 14:00
// UTC with daylight saving, so the cron fires at both hours and this code only
// acts when it is actually 9AM in the office timezone.
//
// Exactly-once: deals.closing_day_email_sent_on holds the closing date the email
// went out for. It is claimed with a conditional UPDATE BEFORE the send, and
// released on a failed send so the next run retries.
//
// Wording lives in the "Closing Day Update" email_templates row (editable without
// a deploy); a missing/inactive row falls back to the copy below.

import supabaseAdmin from "./supabaseAdmin";
import { sendEmail } from "./email/emailTransport";
import { logger } from "./logger";
import { maskEmail } from "./maskEmail";
import { normalizeRecipientEmail } from "./emailIdentity";
import { getLeadFirmKey } from "./leadFirm";
import { brandEmailHtml } from "./emailBrand";
import { OFFICE_TIMEZONE, todayInTimeZone } from "./signingTimezone";
import {
  decodeTemplateBraces,
  escapeHtml,
  renderTemplateSafe,
  type TemplateValue,
} from "./renderEmailTemplate";

export const CLOSING_DAY_TEMPLATE_NAME = "Closing Day Update";
export const CLOSING_DAY_SEND_HOUR = 9;

const FINISHED_DEAL_STATUSES = ["Closed", "Cancelled", "Inactive"];

export interface ClosingDayRunResult {
  /** False when the run was outside the 9AM office hour (nothing attempted). */
  inWindow: boolean;
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

function officeHourNow(now: Date): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: OFFICE_TIMEZONE,
    hour: "numeric",
    hourCycle: "h23",
  }).format(now);
  return Number(h);
}

function fallbackBody(clientName: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Good morning ${clientName},</p>
  <p>Today is your closing day! Our team is working through the final steps to complete your transaction. There’s nothing further you need to do at this stage. If we need anything from you, we’ll reach out directly.</p>
  <p>We’ll keep you updated and let you know as soon as your closing is complete.</p>
  <p>Best regards,</p>
</div>`;
}

interface DueDeal {
  id: string;
  lead_id: string | null;
  client_id: string | null;
  file_number: string | null;
}

async function sendOne(deal: DueDeal): Promise<"sent" | "skipped" | "failed"> {
  if (!deal.client_id) return "skipped";
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("first_name, email")
    .eq("id", deal.client_id)
    .maybeSingle();
  const email = (client?.email ?? "").trim();
  if (!email) return "skipped";

  const firstName = (client?.first_name ?? "").trim() || "there";
  const values: Record<string, TemplateValue> = {
    client_name: { value: firstName },
    first_name: { value: firstName },
    "user.first_name": { value: firstName },
    file_number: { value: deal.file_number ?? "" },
  };
  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
  };

  const { data: templates } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .ilike("name", `%${CLOSING_DAY_TEMPLATE_NAME}%`)
    .order("created_at", { ascending: false });
  const template = (templates ?? []).find((t) => t.is_active && !t.is_deleted && t.body);

  const html = template
    ? renderTemplateSafe(decodeTemplateBraces(template.body), resolve)
    : fallbackBody(escapeHtml(firstName));
  const subject = renderTemplateSafe(
    decodeTemplateBraces(template?.subject || "Your Closing Day Update"),
    resolve,
    { escape: false },
  );

  const firm = await getLeadFirmKey(deal.lead_id);
  const to = normalizeRecipientEmail(email);
  const result = await sendEmail(
    { to: [to], subject, html: brandEmailHtml(html, firm) },
    { firm, label: "closing-day-update" },
  );
  if (!result.ok) {
    logger.error(`[ClosingDay] send failed for deal ${deal.id}: ${result.error}`);
    return "failed";
  }
  logger.info(`[ClosingDay] sent to ${maskEmail(to)}, id=${result.id}`);
  return "sent";
}

/** Cron body. Pass `force` to ignore the 9AM-hour guard (manual/dev runs). */
export async function runClosingDayEmails(
  now: Date = new Date(),
  opts: { force?: boolean } = {},
): Promise<ClosingDayRunResult> {
  const result: ClosingDayRunResult = { inWindow: true, due: 0, sent: 0, skipped: 0, failed: 0 };
  if (!opts.force && officeHourNow(now) !== CLOSING_DAY_SEND_HOUR) {
    return { ...result, inWindow: false };
  }
  if (!process.env.RESEND_API_KEY) {
    logger.error("[ClosingDay] RESEND_API_KEY missing; nothing sent");
    return result;
  }

  const today = todayInTimeZone();
  const { data: deals, error } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, client_id, file_number, status, closing_date, selling_closing_date")
    .or(`closing_date.eq.${today},selling_closing_date.eq.${today}`)
    .or(`closing_day_email_sent_on.is.null,closing_day_email_sent_on.neq.${today}`)
    .limit(500);
  if (error) {
    logger.error("[ClosingDay] query failed:", error.message);
    throw new Error(error.message);
  }

  for (const d of deals ?? []) {
    if (FINISHED_DEAL_STATUSES.includes(d.status ?? "")) continue;
    result.due += 1;
    try {
      // Claim first: only one runner gets the row back.
      const { data: claimed } = await supabaseAdmin
        .from("deals")
        .update({ closing_day_email_sent_on: today })
        .eq("id", d.id)
        .or(`closing_day_email_sent_on.is.null,closing_day_email_sent_on.neq.${today}`)
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      const outcome = await sendOne(d as DueDeal);
      if (outcome === "sent") {
        result.sent += 1;
      } else {
        // Nothing went out: release so a fixed address or a retry can still send.
        await supabaseAdmin.from("deals").update({ closing_day_email_sent_on: null }).eq("id", d.id);
        if (outcome === "skipped") result.skipped += 1;
        else result.failed += 1;
      }
    } catch (err) {
      logger.error(`[ClosingDay] unexpected error for deal ${d.id}:`, err);
      await supabaseAdmin.from("deals").update({ closing_day_email_sent_on: null }).eq("id", d.id);
      result.failed += 1;
    }
  }
  return result;
}
