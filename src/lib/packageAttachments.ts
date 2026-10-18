// How a file's package is PACKED onto an email, and how the email describes it.
//
// Shared by the two senders that mail a file's package — "Email to Clerk"
// (sendClerkDocumentsEmail.ts) and the all-tasks-complete alert
// (notifyAllTasksComplete.ts) — because they had drifted apart. The clerk email
// attached the package's GENERATED pages; the alert never built the package at
// all, so it mailed a file's uploads with no PERSONAL INFORMATION, PROPERTY
// INFORMATION or task-answer PDF on it. Nothing in the document sweep could
// stand in for them either: those pages are answers a client TYPED, and
// collectFamilyDocuments reads task_responses filtered to `field_type = "file"`.
// Reported 2026-09-15 on #26P-0564, where 14 uploads arrived and the clients'
// details did not. One module now, so a change to the packaging reaches both
// emails at once.
//
// Dependency-free on purpose, exactly like clerkRecipients.ts: everything here
// takes its data as arguments and returns strings or buffers, so
// tests/packageEntryAttachments.test.ts can pin the packing rules without
// loading Supabase, the blob store, the email transport or the PDF builder.
// Nothing here logs — the callers own that, and they report `omitted`.

import type { PackageEntry, TaskCoverage } from "./dealPackage";
import type { EmailAttachment } from "./familyDocuments";

/** Strip characters a ZIP entry or an email attachment shouldn't carry. */
export function sanitizeEntryName(name: string): string {
  return (
    String(name ?? "")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Document"
  );
}

export interface PackedEntries {
  attachments: EmailAttachment[];
  /** Bytes spent, so the caller can hand the remainder to the document sweep. */
  bytes: number;
  /** Blobs that reached an entry — `excludeUrls` for the document sweep. */
  consumedUrls: Set<string>;
  /** Per-task answer PDFs, which the "Attached:" breakdown counts on their own. */
  taskPdfs: number;
  /**
   * Titles of entries that did not fit the budget. A generated page has no blob
   * behind it, so — unlike an oversized document — it cannot fall back to a
   * download link. The caller MUST surface these (in the body, and in its log)
   * rather than let the package quietly lose a section.
   */
  omitted: string[];
}

/**
 * The package's GENERATED pages, ready to hang off an email.
 *
 * Spend the email's attachment budget HERE FIRST and pass what is left to
 * collectFamilyDocuments(): these pages are small, and a document that misses
 * the budget still reaches the recipient as a link, where one of these would
 * simply be gone.
 */
export function packageEntryAttachments(
  entries: readonly PackageEntry[],
  opts: { fileNumber?: string | null; budgetBytes: number },
): PackedEntries {
  const stem = opts.fileNumber ? `${sanitizeEntryName(opts.fileNumber)} - ` : "";
  const attachments: EmailAttachment[] = [];
  const consumedUrls = new Set<string>();
  const omitted: string[] = [];
  let bytes = 0;
  let taskPdfs = 0;

  for (const entry of entries) {
    if (bytes + entry.bytes.byteLength > opts.budgetBytes) {
      // Skipped, not abandoned: a smaller entry behind a large one still fits,
      // and shouldn't be punished for what is in front of it.
      omitted.push(entry.title);
      continue;
    }
    bytes += entry.bytes.byteLength;
    attachments.push({
      filename: `${stem}${sanitizeEntryName(entry.title)}.pdf`,
      content: Buffer.from(entry.bytes),
    });
    // Counted by KIND, not by title: the title comparisons this replaced went
    // stale the moment the APS and property entries were added.
    if (entry.kind === "task" || entry.kind === "leftover") taskPdfs++;
    for (const url of entry.consumedUrls) consumedUrls.add(url);
  }

  return { attachments, bytes, consumedUrls, taskPdfs, omitted };
}

/**
 * Number repeated filenames so no attachment can overwrite another.
 *
 * The two halves of these emails are named by rules that DO collide. A task
 * carried by two parties is titled "<task> - <person>" so the copies can be told
 * apart, and every uploaded document is renamed
 * "<file number> - <task name> - <client name>.<ext>" — so a multi-party task
 * holding both typed answers and a PDF upload produces two attachments with
 * byte-identical names. Each half deduped only within itself (dedupe() in
 * familyDocuments.ts; nothing at all here), so the collision survived into the
 * message.
 *
 * MIME allows it and Resend sends it, which is what made this invisible: the
 * count in the log was right and the email showed both. It bites the recipient —
 * "Save all attachments" writes one file over the other, and that is a document
 * that silently never arrived.
 *
 * The ZIP export has guarded against exactly this from the start (see the `used`
 * set in the package route, "most extractors then keep only the last one"). This
 * is the same guard for the email, applied across BOTH halves at once, which is
 * the only place it works.
 */
export function dedupeAttachmentNames(attachments: EmailAttachment[]): EmailAttachment[] {
  const seen = new Map<string, number>();
  return attachments.map((a) => {
    const key = a.filename.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return a;
    const dot = a.filename.lastIndexOf(".");
    const filename =
      dot > 0
        ? `${a.filename.slice(0, dot)} (${count + 1})${a.filename.slice(dot)}`
        : `${a.filename} (${count + 1})`;
    return { ...a, filename };
  });
}

/** A task whose content reached neither an attachment nor a link. */
export interface UncoveredTask {
  /** "Provide Personal Information — Jane Doe", for the log and the email. */
  label: string;
  /** Why it isn't on the email, as far as this can tell. */
  reason: "no_entry" | "entry_omitted" | "documents_unreachable";
}

/**
 * Prove the email carries every task, and name the ones it doesn't.
 *
 * This is the backstop for the whole packaging path. Everything upstream is
 * best-effort by design — every section of buildDealPackage catches and
 * continues, every document sweep degrades to a link, every download failure
 * costs one file — and each of those is individually right. Together they meant
 * a task could go missing with no single place that knew, which is how a file
 * reaches the clerks looking complete while a client's personal information
 * simply isn't on it.
 *
 * So the senders ask this, once, after the message is assembled: for each task
 * that HAS something to ship, did something actually ship? A task is covered by
 * its own (or its merged section's) PDF being attached, or by at least one of
 * its uploads being attached or linked.
 *
 * Callers log the result as an error and name it in the email body — never
 * silently.
 *
 * @param coverage        buildDealPackage's per-task record
 * @param omittedEntries  entry titles packageEntryAttachments could not fit
 * @param reachableUrls   blob urls that were attached OR linked on this email
 */
export function reconcileTaskCoverage(
  coverage: readonly TaskCoverage[],
  omittedEntries: readonly string[],
  reachableUrls: ReadonlySet<string>,
): UncoveredTask[] {
  const omitted = new Set(omittedEntries.map((t) => t.toLowerCase()));
  const uncovered: UncoveredTask[] = [];

  for (const task of coverage) {
    const entryShipped = task.entryTitle !== null && !omitted.has(task.entryTitle.toLowerCase());
    if (entryShipped) continue;
    if (task.fileUrls.some((u) => reachableUrls.has(u))) continue;

    uncovered.push({
      label: task.owner ? `${task.title} — ${task.owner}` : task.title,
      reason:
        task.entryTitle !== null
          ? "entry_omitted"
          : task.fileUrls.length > 0
            ? "documents_unreachable"
            : "no_entry",
    });
  }

  return uncovered;
}

/**
 * The "not on this email" note. Returns "" when nothing is missing, which is the
 * normal case — this block should be a surprise every time it appears.
 */
export function renderUncoveredTasksHtml(uncovered: readonly UncoveredTask[]): string {
  if (uncovered.length === 0) return "";
  const items = uncovered
    .map((u) => `<li>${escapeHtml(u.label)}</li>`)
    .join("");
  return (
    `<div style="margin-top:20px;padding:12px 14px;border:1px solid #fecaca;background:#fef2f2;border-radius:8px;">` +
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#b91c1c;margin:0 0 6px;font-weight:600;">` +
    `${uncovered.length === 1 ? "1 task is" : `${uncovered.length} tasks are`} NOT on this email — ` +
    `open the file to view ${uncovered.length === 1 ? "it" : "them"}:</p>` +
    `<ul style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#b91c1c;margin:0;padding-left:18px;">` +
    `${items}</ul></div>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * "What's attached" — the generated answer PDFs first, then the documents, every
 * one of which travels as its own file.
 *
 * Generated in CODE and appended after the body, deliberately NOT as
 * `{{ placeholders }}` in the email_templates row. That row lives in the SHARED
 * Supabase database, so it is read by every environment at once — local, dev
 * deploy, production — while the code that resolves its placeholders ships
 * per-deploy. A new placeholder in the template therefore renders as a literal
 * "{{ attached_count }}" anywhere the matching code hasn't landed, which is
 * exactly what happened on 2026-08-10. Generating the block here keeps the
 * template stable: an old deploy omits the block rather than emailing raw
 * template syntax.
 *
 * The alert used to describe its attachments with a single sentence — "N of
 * their uploaded documents are attached" — which was true only because it
 * attached nothing but uploads, and which read as a complete package to a clerk
 * who was missing every client's personal information. Naming each part is what
 * makes an absent section visible in the email itself.
 *
 * Returns "" when there is nothing to describe.
 */
export function renderPackageSummaryHtml(pkg: {
  identification: number;
  aps: number;
  personalInfo: number;
  propertyInfo: number;
  taskPdfs: number;
  separate: number;
  estimate?: boolean;
  /** Generated pages that did not fit — named, never dropped quietly. */
  omitted?: string[];
}): string {
  const items: string[] = [];
  if (pkg.estimate) {
    items.push(`<strong>Closing Cost Estimate</strong> — the statement of account prepared for this file`);
  }
  if (pkg.identification > 0) {
    items.push(
      `<strong>Identification</strong> — ${pkg.identification} ID document` +
        `${pkg.identification === 1 ? "" : "s"} combined into one PDF`,
    );
  }
  if (pkg.aps > 0) {
    items.push(
      `<strong>Agreement of Purchase and Sale</strong> — ${pkg.aps === 1 ? "the agreement" : `all ${pkg.aps} agreements and amendments`} ` +
        `combined into one PDF`,
    );
  }
  if (pkg.personalInfo > 0) {
    items.push(
      `<strong>Personal Information</strong> — ${pkg.personalInfo === 1 ? "the client's" : `all ${pkg.personalInfo} clients'`} ` +
        `details in one PDF`,
    );
  }
  if (pkg.propertyInfo > 0) {
    items.push(
      `<strong>Property Information</strong> — the lock box code and rental ` +
        `equipment details for the property`,
    );
  }
  if (pkg.taskPdfs > 0) {
    items.push(
      `${pkg.taskPdfs} task PDF${pkg.taskPdfs === 1 ? "" : "s"} — the answers the client ` +
        `gave on ${pkg.taskPdfs === 1 ? "that task" : "those tasks"}`,
    );
  }
  if (pkg.separate > 0) {
    items.push(
      `${pkg.separate} document${pkg.separate === 1 ? "" : "s"}, each attached ` +
        `individually in the format it was uploaded in`,
    );
  }
  if (items.length === 0) return "";

  const omitted = pkg.omitted ?? [];
  // If a generated page had to be left off, the email says which — the recipient
  // opens the file for it instead of never learning it existed.
  const omittedNote = omitted.length
    ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#b91c1c;margin:0 0 16px;">` +
      `${omitted.length === 1 ? "One section was" : `${omitted.length} sections were`} too large to attach — ` +
      `open the file to view ${escapeHtml(omitted.join(", "))}.</p>`
    : "";

  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">` +
    `<p style="margin:0 0 4px;"><strong>Attached:</strong></p>` +
    `<ul style="margin:0 0 16px;padding-left:20px;">` +
    items.map((i) => `<li>${i}</li>`).join("") +
    `</ul>` +
    omittedNote +
    `</div>`
  );
}
