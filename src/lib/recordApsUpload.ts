import supabaseAdmin from "./supabaseAdmin";
import { completeApsTask } from "./completeApsTask";
import { requestApsDepositRead } from "./requestApsDepositRead";

/** Files APS upload(s) on the lead, completes the family's APS task and requests the deposit read. */
export async function recordApsUpload(
  dealId: string,
  leadId: string,
  side: "purchase" | "sale" | null,
  files: { file_url: string; file_name: string }[],
) {
  const docType = side === "purchase"
    ? "aps_purchase"
    : side === "sale"
    ? "aps_sale"
    : "aps";
  const customType = side === "purchase"
    ? "APS Purchase Document"
    : side === "sale"
    ? "APS Sale Document"
    : "APS Document";
  const { error: docError } = await supabaseAdmin
    .from("lead_corporate_docs")
    .insert(
      files.map((f) => ({
        lead_id: leadId,
        doc_type: docType,
        custom_type: customType,
        file_url: f.file_url,
        file_name: f.file_name,
      })),
    );

  if (docError) return { success: false as const, error: `Failed to record document: ${docError.message}` };

  // The explicit side keeps the other side's APS task untouched.
  const result = await completeApsTask(dealId, {
    forLeadTypes: side === "purchase"
      ? ["Purchase"]
      : side === "sale"
      ? ["Sale"]
      : undefined,
  });

  if (!result.success) return { success: false as const, error: result.error ?? "Task completion failed" };

  // Best-effort: the portal reads the deposit from the new files.
  await requestApsDepositRead({
    dealId,
    side,
    fileUrls: files.map((f) => f.file_url),
  });

  return { success: true as const, already_completed: result.already_completed ?? false, completed_lead_types: result.completed_lead_types ?? [] };
}
