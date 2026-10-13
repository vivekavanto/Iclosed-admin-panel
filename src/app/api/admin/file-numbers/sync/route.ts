import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { logger } from "@/lib/logger";
import { PENDING_FILE_NUMBER_PREFIX } from "@/lib/fileNumber";
import { readTicklerRows } from "@/lib/tickler";
import { matchSide, type PendingSide, type SideMatch } from "@/lib/ticklerMatch";

type FileResult = {
  deal_id: string;
  client: string;
  address: string;
  status: "assigned" | "needs_review" | "not_found" | "error";
  file_number?: string;
  selling_file_number?: string;
  candidates?: { fileNumber: string; label: string }[];
  error?: string;
};

const TYPE_LETTER: Record<string, string> = { Purchase: "P", "Purchase & Sale": "P", Sale: "S", Refinance: "R" };

// POST /api/admin/file-numbers/sync — fills pending file numbers from the Tickler sheet.
export async function POST(req: Request) {
  const { data: deals, error } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, type, file_number, property_address, selling_property_address, created_at")
    .like("file_number", `${PENDING_FILE_NUMBER_PREFIX}%`)
    .eq("is_primary_file", true)
    .eq("is_deleted", false)
    .order("created_at", { ascending: true });
  if (error) {
    logger.error("[file-numbers sync] deals query failed:", error.message);
    return NextResponse.json({ success: false, error: "Could not load pending files" }, { status: 500 });
  }
  if (!deals?.length) return NextResponse.json({ success: true, results: [] });

  let rows;
  try {
    rows = await readTicklerRows();
  } catch (err) {
    logger.error("[file-numbers sync] Tickler read failed:", err);
    return NextResponse.json({ success: false, error: "Could not read the Tickler sheet" }, { status: 502 });
  }

  const leadIds = deals.map((d) => d.lead_id).filter(Boolean) as string[];
  const ticklerNumbers = [...new Set(rows.map((r) => r.fileNumber))];
  const [{ data: leads }, { data: coLeads }, used, usedSelling] = await Promise.all([
    supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, corporate_name, address_street, selling_address_street")
      .in("id", leadIds),
    supabaseAdmin.from("leads").select("parent_lead_id, last_name").in("parent_lead_id", leadIds),
    supabaseAdmin.from("deals").select("file_number").in("file_number", ticklerNumbers),
    supabaseAdmin.from("deals").select("selling_file_number").in("selling_file_number", ticklerNumbers),
  ]);
  if (used.error || usedSelling.error) {
    logger.error("[file-numbers sync] used numbers query failed:", used.error?.message ?? usedSelling.error?.message);
    return NextResponse.json({ success: false, error: "Could not check existing file numbers" }, { status: 500 });
  }
  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));
  const taken = new Set<string>([
    ...(used.data ?? []).map((d) => d.file_number as string),
    ...(usedSelling.data ?? []).map((d) => d.selling_file_number as string),
  ]);

  const results: FileResult[] = [];
  for (const deal of deals) {
    const lead = deal.lead_id ? leadById.get(deal.lead_id) : undefined;
    const lastNames = [
      lead?.last_name,
      lead?.corporate_name,
      ...(coLeads ?? []).filter((c) => c.parent_lead_id === deal.lead_id).map((c) => c.last_name),
    ].filter(Boolean) as string[];
    const side = (typeLetter: string, street: string | null | undefined): PendingSide => ({
      typeLetter,
      street: street ?? "",
      lastNames,
      createdAt: deal.created_at,
    });
    const base: FileResult = {
      deal_id: deal.id,
      client: [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || lead?.corporate_name || "",
      address: deal.property_address ?? "",
      status: "not_found",
    };

    const isPS = deal.type === "Purchase & Sale";
    const main: SideMatch = matchSide(
      side(TYPE_LETTER[deal.type] ?? "P", deal.property_address || lead?.address_street),
      rows,
      taken,
    );
    const sale: SideMatch | null = isPS
      ? matchSide(side("S", deal.selling_property_address || lead?.selling_address_street), rows, taken)
      : null;

    if (main.status !== "matched" || (sale && sale.status !== "matched")) {
      const candidates = [
        ...(main.status === "ambiguous" ? main.candidates : []),
        ...(sale?.status === "ambiguous" ? sale.candidates : []),
      ];
      results.push({ ...base, status: candidates.length ? "needs_review" : "not_found", candidates });
      continue;
    }

    const fileNumber = main.fileNumber;
    const sellingFileNumber = sale?.status === "matched" ? sale.fileNumber : null;
    try {
      await applyFileNumber(deal.id, deal.file_number, fileNumber, sellingFileNumber);
      taken.add(fileNumber);
      if (sellingFileNumber) taken.add(sellingFileNumber);
      results.push({
        ...base,
        status: "assigned",
        file_number: fileNumber,
        ...(sellingFileNumber ? { selling_file_number: sellingFileNumber } : {}),
      });
    } catch (err) {
      logger.error("[file-numbers sync] update failed:", deal.id, err);
      results.push({ ...base, status: "error", error: "Could not save the file number" });
    }
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "deal.file_numbers_sync",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "deal",
    metadata: {
      assigned: results.filter((r) => r.status === "assigned").map((r) => [r.deal_id, r.file_number]),
      pending: results.filter((r) => r.status !== "assigned").length,
    },
    req,
  });

  return NextResponse.json({ success: true, results });
}

async function applyFileNumber(
  dealId: string,
  placeholder: string,
  fileNumber: string,
  sellingFileNumber: string | null,
): Promise<void> {
  const familyIds = await getFamilyDealIds(dealId);
  const update: Record<string, string> = { file_number: fileNumber, updated_at: new Date().toISOString() };
  if (sellingFileNumber) update.selling_file_number = sellingFileNumber;

  const { error } = await supabaseAdmin
    .from("deals")
    .update(update)
    .in("id", familyIds.length ? familyIds : [dealId])
    .eq("file_number", placeholder);
  if (error) throw new Error(error.message);

  const { error: apptError } = await supabaseAdmin
    .from("signing_appointments")
    .update({ file_number: fileNumber })
    .eq("file_number", placeholder);
  if (apptError) logger.error("[file-numbers sync] appointment update failed:", apptError.message);
}
