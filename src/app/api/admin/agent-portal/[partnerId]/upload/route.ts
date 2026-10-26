import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { isBlobUrl } from "@/lib/blobPrivacy";
import { logger } from "@/lib/logger";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { AGENT_UPLOAD_PREFIX } from "@/lib/agentPortal";
import { loadAgentRootLead, loadAgentTask } from "@/lib/agentPortalData";
import { addTaskResponse } from "@/lib/addTaskResponse";
import { recordApsUpload } from "@/lib/recordApsUpload";

const LABEL_MAX = 120;

// POST — files an agent's upload: { taskId, fieldId } into a task (same path as staff),
// or { leadId, label? } as a client-hidden Other Document. Plus { fileUrl, fileName }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ partnerId: string }> }) {
  const { partnerId } = await params;
  const body = await req.json().catch(() => null);
  const { taskId, fieldId, leadId, label, fileUrl, fileName } = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(partnerId)) return NextResponse.json({ success: false, error: "Invalid partner id" }, { status: 400 });
  if (typeof fileUrl !== "string" || !isBlobUrl(fileUrl) || typeof fileName !== "string" || !fileName.trim()) {
    return NextResponse.json({ success: false, error: "A Blob file URL and file name are required" }, { status: 400 });
  }
  const uploadedFor = (owner: string) => new URL(fileUrl).pathname.startsWith(`/${AGENT_UPLOAD_PREFIX}/${owner}/`);

  try {
    const actor = await getActingAdmin();
    const audit = (resourceType: string, resourceId: string, metadata: Record<string, unknown>) =>
      recordAudit({ action: "partner.document_upload", actorEmail: actor.email, actorUserId: actor.id, resourceType, resourceId, metadata: { partnerId, fileName, ...metadata }, req });

    if (typeof leadId === "string") {
      if (!isUuid(leadId) || !(await loadAgentRootLead(partnerId, leadId))) {
        return NextResponse.json({ success: false, error: "File not found" }, { status: 404 });
      }
      if (!uploadedFor(leadId)) return NextResponse.json({ success: false, error: "Invalid upload path" }, { status: 400 });
      const customType = typeof label === "string" && label.trim() ? label.trim().slice(0, LABEL_MAX) : null;
      const { data: doc, error } = await supabaseAdmin
        .from("lead_corporate_docs")
        .insert({ lead_id: leadId, doc_type: "other", custom_type: customType, file_url: fileUrl, file_name: fileName, hidden_from_client: true })
        .select("id")
        .single();
      if (error) throw error;
      await audit("lead", leadId, { docId: doc.id, label: customType });
      return NextResponse.json({ success: true, taskCompleted: false });
    }

    if (typeof taskId !== "string" || !isUuid(taskId) || typeof fieldId !== "string" || !isUuid(fieldId)) {
      return NextResponse.json({ success: false, error: "Invalid task or field id" }, { status: 400 });
    }
    const task = await loadAgentTask(partnerId, taskId);
    if (!task?.task_template_id || !task.lead_id) return NextResponse.json({ success: false, error: "Task not found" }, { status: 404 });
    if (task.status === "Completed") return NextResponse.json({ success: false, error: "This task is already complete" }, { status: 409 });
    if (!uploadedFor(task.lead_id)) return NextResponse.json({ success: false, error: "Invalid upload path" }, { status: 400 });

    const [{ data: field }, { data: template }] = await Promise.all([
      supabaseAdmin
        .from("task_form_fields")
        .select("id, label")
        .eq("id", fieldId)
        .eq("task_template_id", task.task_template_id)
        .eq("field_type", "file")
        .maybeSingle(),
      supabaseAdmin.from("task_templates").select("is_aps_task, lead_type").eq("id", task.task_template_id).maybeSingle(),
    ]);
    if (!field) return NextResponse.json({ success: false, error: "That task has no such file field" }, { status: 400 });

    let taskCompleted: boolean;
    if (template?.is_aps_task) {
      // The agreement has its own path: it is filed on the lead and the deposit is read from it.
      const side = template.lead_type === "Purchase" ? "purchase" : template.lead_type === "Sale" ? "sale" : null;
      const result = await recordApsUpload(task.deal_id, task.lead_id, side, [{ file_url: fileUrl, file_name: fileName }]);
      if (!result.success) throw new Error(result.error);
      taskCompleted = true;
    } else {
      const result = await addTaskResponse({
        task_id: task.id,
        field_id: field.id,
        field_label: field.label,
        field_type: "file",
        value: null,
        file_url: fileUrl,
        file_name: fileName,
      });
      taskCompleted = result.taskCompleted;
    }

    await audit("task", task.id, { dealId: task.deal_id, field: field.label, taskCompleted });
    return NextResponse.json({ success: true, taskCompleted });
  } catch (err) {
    logger.error("[agent-portal] upload failed:", err);
    return NextResponse.json({ success: false, error: "Could not save the upload" }, { status: 500 });
  }
}
