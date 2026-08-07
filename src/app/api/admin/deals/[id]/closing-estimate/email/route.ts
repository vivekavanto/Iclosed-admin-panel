import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { readActiveConfig, readStatementType } from "@/lib/closingCostConfig";
import { configFromSnapshot } from "@/lib/closingCostConfigSnapshot";
import { finalStatementBlocker, snapshotToStatement } from "@/lib/closingEstimate";
import { closingCostPdfFileName, generateClosingCostPdf } from "@/lib/closingCostPdf";
import {
  isEmailAddress,
  sendClosingEstimateEmail,
} from "@/lib/sendClosingEstimateEmail";
import { formatLocalDate } from "@/lib/formatDate";

// POST /api/admin/deals/[id]/closing-estimate/email
//
// Emails a saved estimate to the client with the statement PDF attached.
//
// Sends the FROZEN snapshot, never a live recomputation: the client must
// receive exactly the figures that were saved, and a fee change between saving
// and sending must not silently alter what lands in their inbox. Body is
// optional — `{ to }` overrides the recipient, `{ estimate_id }` picks a
// specific issued row instead of the latest.
//
// Gated to admins by src/middleware.ts.

const supabase = supabaseAdmin;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  // Outward-facing and it costs a send, so cap it harder than the PDF route.
  if (!(await rateLimitOk(`cc-email:${id}`, 5, 60))) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Please wait a moment and try again." },
      { status: 429 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is legitimate: send the latest estimate to the lead's email.
  }

  const { data: deal, error: dealErr } = await supabase
    .from("deals")
    .select("id, file_number, property_address, lead_id, is_deleted")
    .eq("id", id)
    .maybeSingle();

  if (dealErr) {
    logger.error("[ClosingEstimate email] deal read failed:", dealErr.message);
    return NextResponse.json(
      { success: false, error: "Could not load the file" },
      { status: 500 },
    );
  }
  if (!deal || deal.is_deleted) {
    return NextResponse.json({ success: false, error: "File not found" }, { status: 404 });
  }

  // ── Which estimate ──
  const estimateId = typeof body.estimate_id === "string" ? body.estimate_id : null;
  let row: Record<string, unknown> | null = null;

  if (estimateId) {
    if (!isUuid(estimateId)) {
      return NextResponse.json(
        { success: false, error: "Invalid estimate id" },
        { status: 400 },
      );
    }
    const { data } = await supabase
      .from("deal_closing_estimates")
      .select("*")
      .eq("id", estimateId)
      .eq("deal_id", id)
      .eq("is_deleted", false)
      .maybeSingle();
    row = data;
  } else {
    const { data } = await supabase
      .from("deal_closing_estimates")
      .select("*")
      .eq("deal_id", id)
      .eq("status", "issued")
      .eq("is_deleted", false)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    row = data;
  }

  if (!row) {
    return NextResponse.json(
      {
        success: false,
        error: "There is no issued estimate to send. Issue one first.",
      },
      { status: 404 },
    );
  }

  const statement = snapshotToStatement(row.line_items);
  if (!statement) {
    return NextResponse.json(
      { success: false, error: "This estimate has no saved figures to send." },
      { status: 409 },
    );
  }

  // ── Recipient ──
  // An explicit address wins; otherwise the lead's. Never guessed from a name.
  let recipient = typeof body.to === "string" ? body.to.trim() : "";
  if (!recipient && deal.lead_id && isUuid(deal.lead_id)) {
    const { data: lead } = await supabase
      .from("leads")
      .select("email")
      .eq("id", deal.lead_id)
      .maybeSingle();
    recipient = (lead?.email ?? "").trim();
  }
  if (!isEmailAddress(recipient)) {
    return NextResponse.json(
      { success: false, error: "Enter a valid email address to send to." },
      { status: 400 },
    );
  }

  const firmKey = (row.firm_key as string | null) ?? null;
  const isDraftRow = row.status !== "issued";

  // The letterhead and wording come from the estimate's own FROZEN snapshot, so
  // what lands in the client's inbox is the document as it was prepared — a
  // settings edit between saving and sending must not alter it. Same rule, and
  // the same pre-snapshot fallback, as the download route.
  const frozen = configFromSnapshot(row.config_snapshot);
  let config: Record<string, unknown>;
  let statementType: Awaited<ReturnType<typeof readStatementType>>;

  if (frozen) {
    config = frozen.config;
    statementType = frozen.statementType;
  } else {
    config = (await readActiveConfig(firmKey)).row;
    statementType = await readStatementType(
      (row.statement_type as string | null) ?? (isDraftRow ? "draft" : "final"),
    );
  }

  // Issuing is not the only way a statement reaches a client, so the
  // final-account rule is applied on this path too.
  const blocker = finalStatementBlocker(
    statementType.type_key,
    row.property_tax_adjustment,
  );
  if (blocker) {
    return NextResponse.json({ success: false, error: blocker }, { status: 400 });
  }

  const fileNo = (row.file_no_display as string | null) ?? deal.file_number ?? null;
  const propertyAddress =
    (row.property_address as string | null) ?? deal.property_address ?? null;
  const purchasers = (row.purchasers as string | null) ?? null;
  const closingDate = (row.closing_date as string | null) ?? null;

  // ── Attachment ──
  // A failed PDF must not block the send: the summary in the body still carries
  // the balance due, which is the number the client is waiting for.
  let pdf: { fileName: string; bytes: Uint8Array } | null = null;
  try {
    const preparedSource =
      (row.issued_at as string | null) ?? (row.updated_at as string | null) ?? "";
    const bytes = await generateClosingCostPdf({
      statement,
      config,
      statementType,
      fileNo,
      propertyAddress,
      clientName: purchasers,
      closingDate: closingDate ? formatLocalDate(closingDate) || closingDate : null,
      preparedOn: formatLocalDate(preparedSource) || preparedSource.slice(0, 10),
      draft: isDraftRow,
      configVersion: (row.config_version as string | null) ?? null,
    });
    pdf = { fileName: closingCostPdfFileName(fileNo), bytes };
  } catch (err) {
    logger.error("[ClosingEstimate email] pdf generation failed:", err);
  }

  const sent = await sendClosingEstimateEmail({
    to: recipient,
    statement,
    statementType,
    config,
    clientName: purchasers,
    propertyAddress,
    fileNo,
    closingDate: closingDate ? formatLocalDate(closingDate) || closingDate : null,
    pdf,
  });

  if (!sent.success) {
    logger.error("[ClosingEstimate email] send failed:", sent.error);
    return NextResponse.json(
      { success: false, error: sent.error ?? "Could not send the email" },
      { status: 502 },
    );
  }

  const now = new Date().toISOString();
  const { error: stampErr } = await supabase
    .from("deal_closing_estimates")
    .update({ last_emailed_at: now, last_emailed_to: recipient })
    .eq("id", row.id as string);
  if (stampErr) {
    // The client has the email; failing the request now would invite a resend.
    logger.error("[ClosingEstimate email] send stamp failed:", stampErr.message);
  }

  // Sending a statement of account to a client is outward-facing, so it leaves
  // a durable trace beyond the row itself.
  const actor = await getActingAdmin();
  await recordAudit({
    action: "closing_estimate.email",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "deal_closing_estimates",
    resourceId: String(row.id ?? ""),
    metadata: {
      deal_id: id,
      to: recipient,
      statement_type: statementType.type_key,
      pdf_attached: Boolean(pdf),
    },
    req,
  });

  return NextResponse.json({
    success: true,
    sent_to: recipient,
    pdf_attached: Boolean(pdf),
    last_emailed_at: now,
  });
}
