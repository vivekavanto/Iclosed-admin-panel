import supabaseAdmin from "./supabaseAdmin";
import { readActiveConfig, readStatementType } from "./closingCostConfig";
import { configFromSnapshot } from "./closingCostConfigSnapshot";
import { snapshotToStatement } from "./closingEstimate";
import { closingCostPdfFileName, generateClosingCostPdf } from "./closingCostPdf";
import { formatLocalDate } from "./formatDate";
import { logger } from "./logger";

export interface EstimatePdfRow {
  id: string;
  deal_id?: string | null;
  status: string | null;
  file_no_display: string | null;
  line_items: unknown;
  pdf_url: string | null;
  issued_at: string | null;
  updated_at: string | null;
  firm_key?: string | null;
  statement_type?: string | null;
  purchasers?: string | null;
  property_address?: string | null;
  closing_date?: string | null;
  config_snapshot?: unknown;
  config_version?: string | null;
}

export async function renderEstimatePdf(
  dealId: string,
  row: EstimatePdfRow,
): Promise<Uint8Array | null> {
  const statement = snapshotToStatement(row.line_items);
  if (!statement) return null;

  const isDraft = row.status !== "issued";
  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("file_number, property_address")
    .eq("id", dealId)
    .maybeSingle();

  // Pre-snapshot rows fall back to the live config.
  const frozen = configFromSnapshot(row.config_snapshot);
  const config = frozen ? frozen.config : (await readActiveConfig(row.firm_key ?? null)).row;
  const statementType = frozen
    ? frozen.statementType
    : await readStatementType(row.statement_type ?? (isDraft ? "draft" : "final"));

  const preparedSource = row.issued_at ?? row.updated_at ?? "";
  return generateClosingCostPdf({
    statement,
    config,
    statementType,
    fileNo: row.file_no_display ?? deal?.file_number ?? null,
    propertyAddress: row.property_address ?? deal?.property_address ?? null,
    clientName: row.purchasers ?? null,
    closingDate: row.closing_date ?? null,
    preparedOn: formatLocalDate(preparedSource) || preparedSource.slice(0, 10),
    draft: isDraft,
    configVersion: row.config_version ?? null,
  });
}

// Draft first, else the latest issued.
export async function estimatePdfAttachment(
  dealId: string,
  familyDealIds: readonly string[],
): Promise<{ filename: string; content: Buffer } | null> {
  try {
    const dealIds = Array.from(new Set([dealId, ...familyDealIds]));
    const { data } = await supabaseAdmin
      .from("deal_closing_estimates")
      .select("*")
      .in("deal_id", dealIds)
      .eq("is_deleted", false)
      .in("status", ["draft", "issued"]);
    const rows = (data ?? []) as EstimatePdfRow[];
    const rank = (r: EstimatePdfRow) =>
      (r.deal_id === dealId ? 0 : 2) + (r.status === "draft" ? 0 : 1);
    const newest = (r: EstimatePdfRow) => r.issued_at ?? r.updated_at ?? "";
    const row = rows.sort((a, b) => rank(a) - rank(b) || newest(b).localeCompare(newest(a)))[0];
    if (!row) return null;

    const bytes = await renderEstimatePdf(row.deal_id ?? dealId, row);
    if (!bytes) return null;
    return { filename: closingCostPdfFileName(row.file_no_display), content: Buffer.from(bytes) };
  } catch (err) {
    logger.error(`[ClosingEstimate pdf] could not render for the clerk email — deal=${dealId}:`, err);
    return null;
  }
}
