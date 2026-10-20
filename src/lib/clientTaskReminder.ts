// "Complete your pending tasks" reminder to a client.
//
// Two triggers, one sender:
//   - AUTOMATIC, exactly once: runClientTaskReminders() (daily cron, see
//     /api/internal/client-task-reminders) emails a client within 2 days of their
//     first login (AUTO_REMINDER_AFTER_HOURS after it, on the next daily run)
//     if they still have tasks open. The one-shot is
//     clients.task_reminder_sent_at, claimed with a conditional UPDATE before the
//     send so overlapping runs cannot both email.
//   - MANUAL, any number of times: the admin's "Remind client" button
//     (POST /api/admin/deals/[id]/remind-client). It also stamps
//     task_reminder_sent_at so the automatic reminder never doubles up.
//
// First login is clients.first_login_at, stamped once by the activate-deal
// webhook. Clients who logged in before that column existed have NULL there and
// are deliberately never auto-reminded.
//
// Wording lives in the "Pending Tasks Reminder" email_templates row (editable
// without a deploy); a missing/inactive row falls back to the copy below rather
// than going quiet.

import supabaseAdmin from "./supabaseAdmin";
import { sendEmail } from "./email/emailTransport";
import { logger } from "./logger";
import { maskEmail } from "./maskEmail";
import { normalizeRecipientEmail } from "./emailIdentity";
import { getLeadFirmKey } from "./leadFirm";
import { brandEmailHtml } from "./emailBrand";
import { portalUrl } from "./sendDepositTaskEmail";
import { isTaskInactive } from "./depositTask";
import {
  decodeTemplateBraces,
  escapeHtml,
  renderTemplateSafe,
  type TemplateValue,
} from "./renderEmailTemplate";

export const TASK_REMINDER_TEMPLATE_NAME = "Pending Tasks Reminder";

/**
 * Earliest the automatic reminder can go out after first login. The requirement
 * is "within 2 days of logging in", and the cron runs once a day, so waiting 24h
 * means every client is reminded between day 1 and day 2 — never after day 2.
 */
export const AUTO_REMINDER_AFTER_HOURS = 24;

/** Titles beyond this are summarised as "and N more" to keep the email short. */
const MAX_LISTED_TASKS = 10;

const FINISHED_DEAL_STATUSES = ["Closed", "Cancelled", "Inactive"];

export interface TaskReminderResult {
  ok: boolean;
  /** Addresses the mail went to. */
  sent: string[];
  pendingCount: number;
  /** Set when nothing went out: no pending tasks, no address, send refused... */
  reason?: string;
}

interface ReminderClient {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

interface PendingTask {
  title: string;
  deal_id: string;
}

function joinNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/**
 * Open, client-facing tasks across these clients' live files. Mirrors the
 * rollup's rules: deleted tasks and not-yet-activated ("Inactive") tasks never
 * count — the client cannot act on either.
 */
async function loadPendingTasks(
  clientIds: string[],
): Promise<{ tasks: PendingTask[]; fileNumber: string | null; leadId: string | null }> {
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("id, file_number, lead_id, status")
    .in("client_id", clientIds);

  const live = (deals ?? []).filter((d) => !FINISHED_DEAL_STATUSES.includes(d.status ?? ""));
  if (live.length === 0) return { tasks: [], fileNumber: null, leadId: null };

  const { data: rows } = await supabaseAdmin
    .from("tasks")
    .select("title, deal_id, status, completed, role_type, activation_required, activated_at")
    .in(
      "deal_id",
      live.map((d) => d.id),
    )
    .eq("is_deleted", false);

  const seen = new Set<string>();
  const tasks: PendingTask[] = [];
  for (const t of rows ?? []) {
    if (t.status === "Completed" || t.completed) continue;
    if (isTaskInactive(t)) continue;
    // Staff-side tasks are not the client's to complete.
    if (t.role_type && String(t.role_type).toLowerCase() !== "client") continue;
    // Shared tasks exist once per family deal; list each title once.
    const key = String(t.title).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ title: t.title, deal_id: t.deal_id });
  }

  return { tasks, fileNumber: live[0].file_number ?? null, leadId: live[0].lead_id ?? null };
}

function pendingTasksHtml(tasks: PendingTask[]): string {
  const shown = tasks.slice(0, MAX_LISTED_TASKS);
  const items = shown.map((t) => `<li>${escapeHtml(t.title)}</li>`).join("");
  const more =
    tasks.length > shown.length
      ? `<li>and ${tasks.length - shown.length} more</li>`
      : "";
  return `<ul style="margin:8px 0 8px 20px;padding:0;">${items}${more}</ul>`;
}

function fallbackBody(v: Record<string, string>): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi ${v.client_name},</p>
  <p>This is a friendly reminder to log into iClosed and complete your pending tasks so we can keep your file moving.</p>
  ${v.pending_tasks}
  <p style="margin-top:24px;">
    <a href="${v.portal_url}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open my portal
    </a>
  </p>
</div>`;
}

/**
 * Email the given clients ONE reminder listing what is still open. Never
 * throws. Stamps task_reminder_sent_at on success so the automatic reminder
 * cannot follow a manual one.
 */
export async function sendClientTaskReminder(clientIds: string[]): Promise<TaskReminderResult> {
  const fail = (reason: string, pendingCount = 0): TaskReminderResult => ({
    ok: false,
    sent: [],
    pendingCount,
    reason,
  });

  if (!process.env.RESEND_API_KEY) return fail("Email is not configured (RESEND_API_KEY missing).");
  if (clientIds.length === 0) return fail("No client on this file.");

  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("id, first_name, last_name, email")
    .in("id", clientIds);
  const people = ((clients ?? []) as ReminderClient[]).filter((c) => (c.email ?? "").trim());
  if (people.length === 0) return fail("No client on this file has an email address.");

  const { tasks, fileNumber, leadId } = await loadPendingTasks(clientIds);
  if (tasks.length === 0) return fail("This client has no pending tasks.");

  const to = Array.from(
    new Set(people.map((p) => normalizeRecipientEmail(p.email as string))),
  );

  const values: Record<string, TemplateValue> = {
    client_name: { value: joinNames(people.map((p) => p.first_name ?? "")) },
    first_name: { value: joinNames(people.map((p) => p.first_name ?? "")) },
    "user.first_name": { value: joinNames(people.map((p) => p.first_name ?? "")) },
    pending_tasks: { value: pendingTasksHtml(tasks), raw: true },
    pending_count: { value: String(tasks.length) },
    portal_url: { value: portalUrl() },
    file_number: { value: fileNumber ?? "" },
  };
  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
  };

  const { data: templates } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .ilike("name", `%${TASK_REMINDER_TEMPLATE_NAME}%`)
    .order("created_at", { ascending: false });
  const template = (templates ?? []).find((t) => t.is_active && !t.is_deleted && t.body);

  const html = template
    ? renderTemplateSafe(decodeTemplateBraces(template.body), resolve)
    : fallbackBody({
        client_name: escapeHtml(values.client_name.value),
        pending_tasks: values.pending_tasks.value,
        portal_url: escapeHtml(values.portal_url.value),
      });
  const subject = renderTemplateSafe(
    decodeTemplateBraces(
      template?.subject || "Reminder: please complete your pending tasks on iClosed",
    ),
    resolve,
    { escape: false },
  );

  const firm = await getLeadFirmKey(leadId);
  const result = await sendEmail(
    { to, subject, html: brandEmailHtml(html, firm) },
    { firm, label: "client-task-reminder" },
  );
  if (!result.ok) {
    logger.error(`[TaskReminder] send failed for ${to.length} recipient(s): ${result.error}`);
    return fail(result.error ?? "Email send failed.", tasks.length);
  }

  // Burn the one-shot (only where still unset, so an earlier stamp survives).
  await supabaseAdmin
    .from("clients")
    .update({ task_reminder_sent_at: new Date().toISOString() })
    .in("id", clientIds)
    .is("task_reminder_sent_at", null);

  logger.info(`[TaskReminder] sent to ${to.map(maskEmail).join(", ")}, id=${result.id}`);
  return { ok: true, sent: to, pendingCount: tasks.length };
}

export interface ReminderRunResult {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** Daily cron body: remind each client once, within 2 days of first login. */
export async function runClientTaskReminders(now: Date = new Date()): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { due: 0, sent: 0, skipped: 0, failed: 0 };
  const cutoff = new Date(now.getTime() - AUTO_REMINDER_AFTER_HOURS * 60 * 60 * 1000);

  const { data: due, error } = await supabaseAdmin
    .from("clients")
    .select("id")
    .not("first_login_at", "is", null)
    .lte("first_login_at", cutoff.toISOString())
    .is("task_reminder_sent_at", null)
    .limit(200);
  if (error) {
    logger.error("[TaskReminder] query failed:", error.message);
    throw new Error(error.message);
  }

  for (const c of due ?? []) {
    result.due += 1;
    try {
      // Claim first — only one runner gets the row back. Released on a failed
      // send so tomorrow's run retries; kept (never re-sent) on success or when
      // there was nothing to remind about.
      const claimedAt = new Date().toISOString();
      const { data: claimed } = await supabaseAdmin
        .from("clients")
        .update({ task_reminder_sent_at: claimedAt })
        .eq("id", c.id)
        .is("task_reminder_sent_at", null)
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      const sent = await sendClientTaskReminder([c.id]);
      if (sent.ok) {
        result.sent += 1;
      } else if (sent.reason === "This client has no pending tasks.") {
        // Nothing to chase: the one-shot is spent, which is the intent.
        result.skipped += 1;
      } else {
        await supabaseAdmin
          .from("clients")
          .update({ task_reminder_sent_at: null })
          .eq("id", c.id);
        result.failed += 1;
      }
    } catch (err) {
      logger.error(`[TaskReminder] unexpected error for client ${c.id}:`, err);
      await supabaseAdmin.from("clients").update({ task_reminder_sent_at: null }).eq("id", c.id);
      result.failed += 1;
    }
  }
  return result;
}
