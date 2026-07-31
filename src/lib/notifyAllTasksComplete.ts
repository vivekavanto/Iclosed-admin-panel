import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { resolvePrimaryDealId } from "./primaryDeal";
import {
  formatLeadTypeLabel,
  buildLeadAddressPartsForEmail,
  renderTransactionPhrase,
} from "./leadEmailAddress";
import {
  renderTemplateSafe,
  decodeTemplateBraces,
  type TemplateValue,
} from "./renderEmailTemplate";
import { logger } from "./logger";
import { withRetry } from "./retry";

/**
 * Fires the back-office "this client is done" alert: when a client AND their
 * co-party have completed every client-visible task on the file, every active
 * admin gets an email and an in-app notification (sidebar bell).
 *
 * Scope of "all tasks":
 *   • The whole FAMILY, not one deal — a co-purchaser's outstanding ID upload
 *     must hold the alert back. Shared tasks live once on the primary deal;
 *     personal tasks live one-per-person, so we pool both (same rule as
 *     recalcMilestones).
 *   • Every non-deleted task, which is exactly the set the client sees. There
 *     is a `hidden_from_client` flag in the repo's 2026-06-04 migration, but it
 *     was never applied and nothing reads it — the portal serves the client
 *     every non-deleted task. Filtering on it would ignore tasks still on the
 *     client's screen and fire this alert early, so we deliberately don't.
 *
 * Idempotency: `deals.all_tasks_notified_at` on the family's PRIMARY deal is
 * claimed with a conditional UPDATE (NULL → now()), so two task completions
 * landing at once can't both send. It's cleared again the moment the family
 * stops being fully complete, so re-completing after a task reopens (or after a
 * co-person is added) legitimately re-fires.
 *
 * Best-effort by contract: this is called from the tail of milestone recalc and
 * must never break task completion. Callers should still wrap it, but every
 * failure inside is caught and logged rather than thrown.
 */

const TEMPLATE_NAME = "All Tasks Completed";
const NOTIFICATION_TYPE = "deal.all_tasks_complete";

export type NotifyAllTasksResult = {
  notified: boolean;
  /** Why nothing was sent — for logs/tests. */
  reason?:
    | "no_tasks"
    | "not_all_complete"
    | "already_notified"
    | "no_recipients"
    | "template_inactive"
    | "template_missing"
    | "email_not_configured"
    | "error";
  emailedTo?: number;
};

/** Absolute link back into the admin portal for the email CTA. */
function adminBaseUrl(): string {
  const explicit = process.env.ADMIN_PORTAL_URL || process.env.NEXT_PUBLIC_ADMIN_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * `deals.closing_date` is a DATE. Parsing it with `new Date("2026-03-14")` gives
 * UTC midnight, which renders as the *previous* day in any negative-offset
 * timezone — so format the Y/M/D parts explicitly in UTC instead.
 */
function formatClosingDate(raw: string | null | undefined): string {
  if (!raw) return "TBD";
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(raw);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toLocaleDateString(
    "en-CA",
    { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" },
  );
}

function fullName(row: { first_name?: string | null; last_name?: string | null }): string {
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
}

/** "Jane Doe", "Jane Doe and John Doe", "Jane Doe, John Doe and Amy Doe". */
function joinNames(names: string[]): string {
  const clean = names.filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/**
 * Who gets the alert email.
 *
 * Defaults to the firm's alert inbox rather than fanning out to every admin —
 * one place to watch, and no risk of blasting the whole team while the feature
 * is being tuned. Override with ALL_TASKS_ALERT_TO:
 *
 *   ALL_TASKS_ALERT_TO="ops@example.com,clerk@example.com"  → those addresses
 *   ALL_TASKS_ALERT_TO="admins"                             → every active
 *                                                             admin_users row
 *
 * The in-app notification is unaffected either way — it's a broadcast row, so
 * every admin still sees it in the sidebar bell regardless of who is emailed.
 */
const DEFAULT_ALERT_TO = "testing@navawilson.law";

async function resolveRecipients(): Promise<string[]> {
  const configured = (process.env.ALL_TASKS_ALERT_TO ?? DEFAULT_ALERT_TO).trim();

  if (configured.toLowerCase() === "admins") {
    const { data: admins } = await supabaseAdmin
      .from("admin_users")
      .select("email")
      .eq("is_active", true);
    return Array.from(
      new Set((admins ?? []).map((a) => (a.email ?? "").trim()).filter(Boolean)),
    );
  }

  return Array.from(
    new Set(
      configured
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/** Clears the claim so a later re-completion can alert again. */
async function releaseClaim(primaryDealId: string): Promise<void> {
  await supabaseAdmin
    .from("deals")
    .update({ all_tasks_notified_at: null })
    .eq("id", primaryDealId)
    .not("all_tasks_notified_at", "is", null);
}

export async function maybeNotifyAllTasksComplete(
  dealId: string,
): Promise<NotifyAllTasksResult> {
  try {
    // Resolve the family independently of whatever the caller passed —
    // maybeCompleteFileTask recalcs a single co-client deal in isolation, and
    // "everyone is done" is only meaningful family-wide.
    const [familyDealIds, primaryDealId] = await Promise.all([
      getFamilyDealIds(dealId),
      resolvePrimaryDealId(dealId),
    ]);
    const dealIds = Array.from(new Set([...familyDealIds, primaryDealId, dealId]));

    // Shared tasks are a single source of truth on the primary deal; personal
    // tasks exist per person. Pooling both mirrors recalcMilestonesForFamily.
    const [{ data: sharedTasks }, { data: personalTasks }] = await Promise.all([
      supabaseAdmin
        .from("tasks")
        .select("id, status")
        .eq("deal_id", primaryDealId)
        .eq("is_shared", true)
        .eq("is_deleted", false),
      supabaseAdmin
        .from("tasks")
        .select("id, status")
        .in("deal_id", dealIds)
        .or("is_shared.is.null,is_shared.eq.false")
        .eq("is_deleted", false),
    ]);

    const pooled = [...(sharedTasks ?? []), ...(personalTasks ?? [])];

    // A file with no client-visible tasks at all has not "completed" anything —
    // don't alert on a freshly converted deal whose templates haven't landed.
    if (pooled.length === 0) {
      await releaseClaim(primaryDealId);
      return { notified: false, reason: "no_tasks" };
    }

    if (!pooled.every((t) => t.status === "Completed")) {
      // Something reopened (or a co-person brought new tasks) — drop the claim
      // so the alert can fire again once the family finishes.
      await releaseClaim(primaryDealId);
      return { notified: false, reason: "not_all_complete" };
    }

    // Atomically CLAIM the alert before doing any work, so two completions
    // racing to the finish line can't both send. Only the caller that flips
    // NULL → now() wins.
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from("deals")
      .update({ all_tasks_notified_at: new Date().toISOString() })
      .eq("id", primaryDealId)
      .is("all_tasks_notified_at", null)
      .select("id");

    if (claimErr) {
      logger.error(
        `[AllTasksComplete] failed to claim alert for deal=${primaryDealId}:`,
        claimErr,
      );
      return { notified: false, reason: "error" };
    }
    if (!claimed || claimed.length === 0) {
      return { notified: false, reason: "already_notified" };
    }

    return await dispatchAlert(primaryDealId, dealIds, pooled.length);
  } catch (err) {
    logger.error(`[AllTasksComplete] unexpected failure for deal=${dealId}:`, err);
    return { notified: false, reason: "error" };
  }
}

/**
 * Builds the alert payload, writes the in-app notification, and emails every
 * active admin. Only called once the claim has been won.
 */
async function dispatchAlert(
  primaryDealId: string,
  familyDealIds: string[],
  taskCount: number,
): Promise<NotifyAllTasksResult> {
  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, file_number, type, closing_date, property_address, selling_property_address")
    .eq("id", primaryDealId)
    .maybeSingle();

  if (!deal) {
    logger.warn(`[AllTasksComplete] primary deal ${primaryDealId} vanished — skipping`);
    return { notified: false, reason: "error" };
  }

  // Primary lead drives the address/type rendering; the rest of the family
  // supplies the co-party names.
  const { data: primaryLead } = deal.lead_id
    ? await supabaseAdmin.from("leads").select("*").eq("id", deal.lead_id).maybeSingle()
    : { data: null };

  const rootLeadId = primaryLead?.parent_lead_id ?? primaryLead?.id ?? null;
  const { data: familyLeads } = rootLeadId
    ? await supabaseAdmin
        .from("leads")
        .select("id, first_name, last_name, parent_lead_id, co_person_role")
        .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)
        .eq("is_deleted", false)
    : { data: null };

  const clientName = primaryLead ? fullName(primaryLead) : "";
  const coPartyNames = (familyLeads ?? [])
    .filter((l) => l.id !== primaryLead?.id)
    .map(fullName)
    .filter(Boolean);

  const partySummary = joinNames([clientName, ...coPartyNames]) || clientName || "Client";

  const leadTypeLabel = formatLeadTypeLabel(primaryLead?.lead_type ?? deal.type);
  const addressParts = await buildLeadAddressPartsForEmail(primaryLead);
  const propertyAddress =
    [addressParts.purchase, addressParts.selling].filter(Boolean).join(" and ") ||
    deal.property_address ||
    deal.selling_property_address ||
    "";
  // "Purchase of 12 King St, Toronto, ON" / "Purchase of X and Sale of Y".
  const transaction =
    renderTransactionPhrase(addressParts, leadTypeLabel) ||
    (propertyAddress ? `${leadTypeLabel} of ${propertyAddress}`.trim() : "");

  const closingDate = formatClosingDate(deal.closing_date);
  const fileNumber = deal.file_number ?? "";
  const dealUrl = `${adminBaseUrl()}/admin/deals/${deal.id}`;

  const title = `All tasks completed — ${partySummary}`;
  const body =
    `${partySummary}${transaction ? ` (${transaction})` : ""} ` +
    `has completed all ${taskCount} task${taskCount === 1 ? "" : "s"} on iClosed. ` +
    `Closing date: ${closingDate}.`;

  // 1. In-app notification. Written FIRST so the bell is right even if Resend
  //    is down or no template is configured.
  const { error: notifErr } = await supabaseAdmin.from("notifications").insert({
    type: NOTIFICATION_TYPE,
    title,
    body,
    deal_id: deal.id,
    lead_id: deal.lead_id ?? null,
    file_number: fileNumber || null,
    metadata: {
      client_name: clientName,
      co_party_names: coPartyNames,
      transaction,
      property_address: propertyAddress,
      closing_date: closingDate,
      lead_type: leadTypeLabel,
      task_count: taskCount,
      family_deal_ids: familyDealIds,
    },
  });
  if (notifErr) {
    logger.error("[AllTasksComplete] failed to write in-app notification:", notifErr);
  }

  // 2. Email the alert inbox.
  const recipients = await resolveRecipients();

  if (recipients.length === 0) {
    logger.warn(
      `[AllTasksComplete] no alert recipients resolved — in-app only. deal=${deal.id}`,
    );
    return { notified: true, reason: "no_recipients", emailedTo: 0 };
  }

  const { data: templates } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .ilike("name", `%${TEMPLATE_NAME}%`)
    .order("created_at", { ascending: false });

  if (!templates || templates.length === 0) {
    logger.warn(
      `[AllTasksComplete] no "${TEMPLATE_NAME}" email template configured — in-app only. deal=${deal.id}`,
    );
    return { notified: true, reason: "template_missing", emailedTo: 0 };
  }

  // Same contract as the other senders: marking the template inactive is a real
  // off-switch for the email (the in-app notification still lands).
  const template = templates.find((t) => t.is_active);
  if (!template?.body || template.body.trim() === "") {
    logger.info(
      `[AllTasksComplete] email skipped — "${TEMPLATE_NAME}" template inactive or empty. deal=${deal.id}`,
    );
    return { notified: true, reason: "template_inactive", emailedTo: 0 };
  }

  const values: Record<string, string> = {
    client_name: clientName,
    co_party_names: coPartyNames.join(", "),
    party_summary: partySummary,
    transaction,
    property_address: propertyAddress,
    closing_date: closingDate,
    file_number: fileNumber,
    lead_type: leadTypeLabel,
    task_count: String(taskCount),
    deal_url: dealUrl,
  };
  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    if (!Object.prototype.hasOwnProperty.call(values, key)) return null;
    // deal_url is system-generated, so it may pass through unescaped inside the
    // href. Everything else is client-supplied and gets HTML-escaped.
    return { value: values[key], raw: key === "deal_url" };
  };

  const html = renderTemplateSafe(decodeTemplateBraces(template.body), resolve);
  const subject = renderTemplateSafe(
    template.subject?.trim() ? template.subject : template.name,
    resolve,
    { escape: false },
  );

  if (!process.env.RESEND_API_KEY) {
    logger.warn(
      `[AllTasksComplete] RESEND_API_KEY missing — in-app notification only. deal=${deal.id}`,
    );
    return { notified: true, reason: "email_not_configured", emailedTo: 0 };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  try {
    await withRetry(
      async () => {
        const { data, error } = await resend.emails.send({
          from: fromEmail,
          to: recipients,
          subject,
          html,
        });
        if (error) throw new Error(error.message);
        return data;
      },
      { attempts: 3, label: "all-tasks-complete-email" },
    );
    logger.info(
      `[AllTasksComplete] alerted ${recipients.length} admin(s) — deal=${deal.id} file=${fileNumber}`,
    );
  } catch (sendErr) {
    // Deliberately NOT releasing the claim: the in-app notification is already
    // written, and releasing would re-insert a duplicate on the next task edit.
    // The alert is not lost — it's in the bell — so just surface the failure.
    logger.error(
      `[AllTasksComplete] email send failed after retries — deal=${deal.id} (in-app notification was still created):`,
      sendErr,
    );
    return { notified: true, reason: "error", emailedTo: 0 };
  }

  return { notified: true, emailedTo: recipients.length };
}
