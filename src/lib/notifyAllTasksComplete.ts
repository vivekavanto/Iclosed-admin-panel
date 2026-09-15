import { sendEmail } from "./email/emailTransport";
import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { resolvePrimaryDealId } from "./primaryDeal";
import { isTaskInactive } from "./depositTask";
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
import {
  ATTACHMENT_BUDGET_BYTES,
  collectFamilyDocuments,
  renderLinkedDocsHtml,
  withEmailDocumentLinks,
} from "./familyDocuments";
import { buildDealPackage, type DealPackageResult } from "./dealPackage";
import { packageEntryAttachments, renderPackageSummaryHtml } from "./packageAttachments";
import { ALL_TASKS_COMPLETE_TYPE } from "./notificationTypes";
import { logger } from "./logger";

/**
 * Fires the back-office "this client is done" alert: when a client AND their
 * co-party have completed every client-visible task on the file, the clerk
 * inbox gets an email (see DEFAULT_ALERT_TO / ALL_TASKS_ALERT_TO below) and
 * every admin gets an in-app notification (sidebar bell).
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
 *   • EXCEPT tasks awaiting activation (`activation_required` with no
 *     `activated_at`), which genuinely are off the client's screen — see the
 *     2026-08-26 migration. Those must not hold the alert: the closing-funds
 *     task is switched on in response to this very alert.
 *
 * The email carries the file's WHOLE package as attachments, built the same way
 * "Email to Clerk" builds it (sendClerkDocumentsEmail.ts) so the two can't
 * disagree about what is on a file:
 *
 *   • the GENERATED pages from buildDealPackage(deal, { mergeDocuments: false })
 *     — personal information, property information, one PDF per task of that
 *     task's typed answers — attached FIRST, because no blob exists behind them;
 *   • then every uploaded DOCUMENT (familyDocuments.ts), each in its own bytes.
 *
 * Anything over the size budget is listed as a download link instead, and a
 * generated page that somehow doesn't fit is NAMED in the body rather than
 * quietly left off.
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
 * Routed to the clerk who picks the file up once the client is done, rather than
 * to every active admin — the whole team being emailed on every completed file
 * was noise, and the alert is also in the bell for everyone anyway.
 *
 * Override with ALL_TASKS_ALERT_TO:
 *
 *   ALL_TASKS_ALERT_TO="aliya@navawilson.law"               → that address
 *                                                             (the default)
 *   ALL_TASKS_ALERT_TO="ops@example.com,clerk@example.com"  → those addresses
 *   ALL_TASKS_ALERT_TO="admins"                             → back to every
 *                                                             active admin_users
 *                                                             row
 *
 * The in-app notification is unaffected either way — it's a broadcast row, so
 * every admin still sees it in the bell regardless of who is emailed.
 */
const DEFAULT_ALERT_TO = "aliya@navawilson.law";

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
        .select("id, status, activation_required, activated_at")
        .eq("deal_id", primaryDealId)
        .eq("is_shared", true)
        .eq("is_deleted", false),
      supabaseAdmin
        .from("tasks")
        .select("id, status, activation_required, activated_at")
        .in("deal_id", dealIds)
        .or("is_shared.is.null,is_shared.eq.false")
        .eq("is_deleted", false),
    ]);

    // Tasks awaiting an admin's activation are dropped, not counted as
    // outstanding. The closing-funds task is created switched off and is only
    // switched on once the firm has drawn up the Final Statement of Account —
    // which is prompted by THIS alert. Counting it would deadlock the file:
    // the alert waits on the task and the task waits on the alert.
    const pooled = [...(sharedTasks ?? []), ...(personalTasks ?? [])].filter(
      (t) => !isTaskInactive(t),
    );

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
  // Street line only — "2615 Ellesmere Road", not the full
  // "2615 Ellesmere Road, Toronto, ON, M1H 2S6". Subject lines truncate in an
  // inbox list, so the part that identifies the file has to come first.
  //
  // Derived from the SAME joined strings rather than read off the lead columns,
  // so it inherits buildLeadAddressPartsForEmail's family-side fallbacks (a
  // co-lead holding the sale side, etc). joinAddress there glues street, city,
  // province and postal with ", ", so the first segment is the street.
  const streetOf = (joined: string) => (joined.split(",")[0] ?? "").trim();
  const propertyStreet =
    [streetOf(addressParts.purchase), streetOf(addressParts.selling)]
      .filter(Boolean)
      .join(" and ") ||
    streetOf(deal.property_address ?? "") ||
    streetOf(deal.selling_property_address ?? "") ||
    "";
  // "Purchase of 12 King St, Toronto, ON" / "Purchase of X and Sale of Y".
  const transaction =
    renderTransactionPhrase(addressParts, leadTypeLabel) ||
    (propertyAddress ? `${leadTypeLabel} of ${propertyAddress}`.trim() : "");

  const closingDate = formatClosingDate(deal.closing_date);
  const fileNumber = deal.file_number ?? "";
  const dealUrl = `${adminBaseUrl()}/admin/deals/${deal.id}`;

  // Reads as the one-line sentence the bell shows, so the dropdown needs no
  // second line to make sense; `body` carries the supporting detail.
  const title =
    `Your client ${partySummary}${propertyAddress ? ` (${propertyAddress})` : ""} ` +
    `has just completed all tasks, please review.`;
  const body =
    `${taskCount} task${taskCount === 1 ? "" : "s"} completed` +
    `${transaction ? ` · ${transaction}` : ""} · Closing ${closingDate}.`;

  // 1. In-app notification. Written FIRST so the bell is right even if Resend
  //    is down or no template is configured.
  const { error: notifErr } = await supabaseAdmin.from("notifications").insert({
    type: ALL_TASKS_COMPLETE_TYPE,
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

  // The file's WHOLE package rides along with the alert, so the reviewer has it
  // in hand rather than having to open the file. Done AFTER the template checks
  // so an inactive template costs us no downloads.
  //
  // Two halves, and for a long time this had only the second:
  //
  //   1. The package's GENERATED pages — PERSONAL INFORMATION (every party's
  //      answers), PROPERTY INFORMATION (the lock box code and the rental
  //      equipment answers) and one PDF per TASK of that task's typed answers.
  //      Nothing else carries them: they are answers a client TYPED, and the
  //      document sweep below reads task_responses filtered to
  //      `field_type = "file"`, so no document exists to stand in for them.
  //      Their absence is what the clerks reported on 2026-09-15 (#26P-0564 went
  //      out with 14 uploads and not one line of the clients' details).
  //   2. Every uploaded DOCUMENT, each in the bytes it was uploaded with.
  //
  // Built exactly the way "Email to Clerk" builds it — same buildDealPackage,
  // same packageEntryAttachments, same collectFamilyDocuments — because these
  // two emails going out with different contents is the whole bug.
  const familyLeadIds = (familyLeads ?? []).map((l) => l.id);

  // Best-effort by contract: a package failure must cost the alert its generated
  // pages, never the documents or the email itself.
  let pkg: DealPackageResult | null = null;
  try {
    pkg = await buildDealPackage(deal.id, { mergeDocuments: false });
  } catch (err) {
    logger.error(`[AllTasksComplete] deal package failed for deal=${deal.id}:`, err);
  }
  if (!pkg) {
    logger.error(
      `[AllTasksComplete] no deal package for deal=${deal.id} — the alert goes out with ` +
        `uploaded documents only (no personal/property information)`,
    );
  }

  // Spend the budget on the generated pages FIRST: they are small, and unlike a
  // document there is no blob behind them to fall back to a download link.
  const entries = pkg
    ? packageEntryAttachments(pkg.entries, {
        fileNumber,
        budgetBytes: ATTACHMENT_BUDGET_BYTES,
      })
    : packageEntryAttachments([], { fileNumber, budgetBytes: ATTACHMENT_BUDGET_BYTES });
  if (entries.omitted.length) {
    // error, not warn: a generated page has no blob to link in its place, so
    // this is the package genuinely losing a section. The body says so too.
    logger.error(
      `[AllTasksComplete] generated entries too large to attach — deal=${deal.id}: ` +
        `${entries.omitted.join(", ")}`,
    );
  }

  // Whatever budget is left carries the documents. Nothing is dropped: anything
  // past the budget, over the per-file ceiling, or whose blob won't download
  // comes back in `linked` and is listed as a download link below.
  //
  // Same `<file number> - <task name> - <client name>` naming the clerk email
  // uses — this alert lands in the same clerk's inbox, and a file arriving under
  // two different names depending on which email carried it is what made the two
  // packages hard to reconcile in the first place.
  const collected = await collectFamilyDocuments(familyDealIds, familyLeadIds, adminBaseUrl(), {
    fileNumber,
    excludeUrls: entries.consumedUrls,
    budgetBytes: Math.max(0, ATTACHMENT_BUDGET_BYTES - entries.bytes),
  });
  // Anything too big to attach travels as a link that works from an inbox, not
  // one that needs an admin session.
  const docs = await withEmailDocumentLinks(collected, {
    email: recipients[0],
    dealId: deal.id,
  });
  const attachments = [...entries.attachments, ...docs.attachments];

  const values: Record<string, string> = {
    client_name: clientName,
    co_party_names: coPartyNames.join(", "),
    party_summary: partySummary,
    transaction,
    property_address: propertyAddress,
    property_street: propertyStreet,
    closing_date: closingDate,
    file_number: fileNumber,
    lead_type: leadTypeLabel,
    task_count: String(taskCount),
    deal_url: dealUrl,
    // Counts now cover the WHOLE package, generated pages included, so a
    // template that renders {{ attached_count }} matches what is on the email.
    document_count: String(attachments.length + docs.linked.length),
    attached_count: String(attachments.length),
    linked_count: String(docs.linked.length),
    separate_count: String(docs.attachments.length),
    identification_count: String(pkg?.identificationDocs ?? 0),
    aps_count: String(pkg?.apsDocs ?? 0),
    personal_info_count: String(pkg?.personalInfoPeople ?? 0),
    property_info_count: String(pkg?.propertyInfoRows ?? 0),
  };
  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    if (!Object.prototype.hasOwnProperty.call(values, key)) return null;
    // deal_url is system-generated, so it may pass through unescaped inside the
    // href. Everything else is client-supplied and gets HTML-escaped.
    return { value: values[key], raw: key === "deal_url" };
  };

  // The "Attached:" breakdown and the "too large to attach" links are APPENDED
  // rather than templated. The template row is shared by every environment via
  // the database, so a new {{ placeholder }} in it renders literally wherever
  // the code hasn't shipped (this bit us on 2026-08-10).
  //
  // This replaced the old "N of their uploaded documents are attached" sentence
  // — accurate only while the alert attached nothing BUT uploads, and the line
  // that told the clerks the package was complete when it was missing every
  // client's personal information. The shared breakdown names each part, so a
  // missing section is now visible in the email itself.
  const html =
    renderTemplateSafe(decodeTemplateBraces(template.body), resolve) +
    renderPackageSummaryHtml({
      identification: pkg?.identificationDocs ?? 0,
      aps: pkg?.apsDocs ?? 0,
      personalInfo: pkg?.personalInfoPeople ?? 0,
      propertyInfo: pkg?.propertyInfoRows ?? 0,
      taskPdfs: entries.taskPdfs,
      separate: docs.attachments.length,
      omitted: entries.omitted,
    }) +
    renderLinkedDocsHtml(docs.linked);
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

  // Internal staff alert: firm-agnostic by design, so `firm: null` keeps the
  // legacy sender and pins it to Resend regardless of any SMTP rollout. Like the
  // clerk email this can carry 25 MB of attachments, which is the payload least
  // likely to survive an SMTP server's SIZE limit. `replyTo: null` preserves the
  // existing behaviour of setting none.
  const result = await sendEmail(
    {
      to: recipients,
      subject,
      html,
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    { firm: null, label: "all-tasks-complete", replyTo: null },
  );

  if (result.ok) {
    logger.info(
      `[AllTasksComplete] alerted ${recipients.length} admin(s) — deal=${deal.id} ` +
        `file=${fileNumber} attached=${attachments.length} ` +
        `(generated=${entries.attachments.length} [personal info for ${pkg?.personalInfoPeople ?? 0}, ` +
        `property rows=${pkg?.propertyInfoRows ?? 0}, task pdfs=${entries.taskPdfs}], ` +
        `documents=${docs.attachments.length}) / ${docs.linked.length} linked` +
        `${entries.omitted.length ? ` — OMITTED: ${entries.omitted.join(", ")}` : ""} ` +
        `(${Math.round((entries.bytes + docs.attachedBytes) / 1024)}KB)`,
    );
  } else {
    // Deliberately NOT releasing the claim: the in-app notification is already
    // written, and releasing would re-insert a duplicate on the next task edit.
    // The alert is not lost — it's in the bell — so just surface the failure.
    logger.error(
      `[AllTasksComplete] email send failed after retries — deal=${deal.id} ` +
        `(in-app notification was still created): ${result.error}`,
    );
    return { notified: true, reason: "error", emailedTo: 0 };
  }

  return { notified: true, emailedTo: recipients.length };
}
