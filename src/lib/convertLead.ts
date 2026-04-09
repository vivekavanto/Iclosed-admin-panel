import supabaseAdmin from "./supabaseAdmin";
import { completeApsTask } from "./completeApsTask";
import { sendAuthEmailViaResend } from "./sendAuthEmail";

export type ConvertOneResult = {
  success: boolean;
  created: boolean;
  lead_id: string;
  deal_id?: string;
  file_number?: string;
  client_id?: string;
  invite_sent?: boolean;
  auth_error?: string | null;
  error?: string;
  statusCode?: number;
};

export async function convertSingleLead(
  lead: any,
  opts: {
    file_number?: string;
    closing_date?: string;
    existingDealBehavior: "error" | "skip";
  },
): Promise<ConvertOneResult> {
  const leadId: string = lead.id;

  try {
    // Check if this lead has already been converted.
    const { data: existingDeal } = await supabaseAdmin
      .from("deals")
      .select("id, file_number, client_id")
      .eq("lead_id", leadId)
      .maybeSingle();

    if (existingDeal) {
      if (opts.existingDealBehavior === "error") {
        return {
          success: false,
          created: false,
          lead_id: leadId,
          statusCode: 409,
          error: `Lead already converted to deal ${existingDeal.file_number}`,
        };
      }

      await supabaseAdmin.from("leads").update({ status: "Converted" }).eq("id", leadId);

      return {
        success: true,
        created: false,
        lead_id: leadId,
        deal_id: existingDeal.id,
        file_number: existingDeal.file_number,
        client_id: existingDeal.client_id,
        invite_sent: false,
        auth_error: null,
      };
    }

    // ── Create or find client record ─────────────────────────────────────────
    let clientId: string;

    const { data: existingClient } = await supabaseAdmin
      .from("clients")
      .select("id, auth_user_id")
      .eq("email", lead.email)
      .maybeSingle();

    if (existingClient) {
      clientId = existingClient.id;
    } else {
      const { data: newClient, error: clientError } = await supabaseAdmin
        .from("clients")
        .insert({
          email: lead.email,
          first_name: lead.first_name,
          last_name: lead.last_name,
          phone: lead.phone ?? null,
        })
        .select("id")
        .single();

      if (clientError || !newClient) {
        return {
          success: false,
          created: false,
          lead_id: leadId,
          statusCode: 500,
          error: `Failed to create client: ${clientError?.message}`,
        };
      }

      clientId = newClient.id;
    }

    // ── Generate file number ─────────────────────────────────────────────────
    const leadTypePrefix = lead.lead_type?.charAt(0)?.toUpperCase() ?? "X";
    const year = new Date().getFullYear().toString().slice(-2);
    const prefix = `${year}${leadTypePrefix}-`;

    let generatedFileNumber = opts.file_number;
    if (!generatedFileNumber) {
      const { data: allDeals } = await supabaseAdmin
        .from("deals")
        .select("file_number")
        .like("file_number", `${prefix}%`);

      let maxNum = 0;
      if (allDeals) {
        for (const d of allDeals) {
          const suffix = d.file_number.replace(prefix, "");
          if (!/^\d+$/.test(suffix)) continue;
          const numPart = parseInt(suffix, 10);
          if (!isNaN(numPart) && numPart > maxNum) maxNum = numPart;
        }
      }

      for (let attempt = 1; attempt <= 10; attempt++) {
        const candidate = `${prefix}${String(maxNum + attempt).padStart(4, "0")}`;
        const { data: exists } = await supabaseAdmin
          .from("deals")
          .select("id")
          .eq("file_number", candidate)
          .maybeSingle();

        if (!exists) {
          generatedFileNumber = candidate;
          break;
        }
      }

      if (!generatedFileNumber) {
        generatedFileNumber = `${prefix}${String(maxNum + 100).padStart(4, "0")}`;
      }
    }

    if (opts.file_number) {
      const { data: exists } = await supabaseAdmin
        .from("deals")
        .select("id")
        .eq("file_number", opts.file_number)
        .maybeSingle();

      if (exists) {
        return {
          success: false,
          created: false,
          lead_id: leadId,
          error: `File number "${opts.file_number}" already exists`,
          statusCode: 409,
        };
      }
    }

    // ── Clean price ──────────────────────────────────────────────────────────
    const rawPrice = lead.price ? String(lead.price).replace(/[^0-9.]/g, "") : null;
    const cleanPrice = rawPrice ? parseFloat(rawPrice) : null;

    // ── Create the deal ──────────────────────────────────────────────────────
    const { data: deal, error: dealError } = await supabaseAdmin
      .from("deals")
      .insert({
        lead_id: leadId,
        client_id: clientId,
        file_number: generatedFileNumber,
        type: lead.lead_type ?? "Purchase",
        status: "Active",
        property_address: lead.address_street ?? "Address TBD",
        closing_date: opts.closing_date ?? null,
        price: cleanPrice ?? 0,
      })
      .select("id")
      .single();

    if (dealError || !deal) {
      return {
        success: false,
        created: false,
        lead_id: leadId,
        statusCode: 500,
        error: `Failed to create deal: ${dealError?.message}`,
      };
    }

    const dealId = deal.id;
    const leadType = lead.lead_type ?? "Purchase";

    await supabaseAdmin.from("leads").update({ status: "Converted" }).eq("id", leadId);

    // ── Copy stage_templates → milestones ────────────────────────────────────
    const stageToMilestone: Record<string, string> = {};

    try {
      const { data: stageTemplates } = await supabaseAdmin
        .from("stage_templates")
        .select("*")
        .eq("lead_type", leadType)
        .order("order_index", { ascending: true });

      if (stageTemplates && stageTemplates.length > 0) {
        const milestoneRows = stageTemplates.map((st) => ({
          deal_id: dealId,
          title: st.name,
          status: "Pending",
          order_index: st.order_index,
          email_template_id: st.email_template_id ?? null,
          stage_template_id: st.id,
          description: st.description ?? null,
        }));

        const { data: milestones, error: msError } = await supabaseAdmin
          .from("milestones")
          .insert(milestoneRows)
          .select("id, stage_template_id");

        if (!msError && milestones) {
          for (const ms of milestones) {
            if (ms.stage_template_id) {
              stageToMilestone[ms.stage_template_id] = ms.id;
            }
          }
        }
      }
    } catch (err) {
      console.error("[Convert] Failed to copy stage templates (non-blocking):", err);
    }

    // ── Copy task_templates → tasks ──────────────────────────────────────────
    try {
      const { data: taskTemplates } = await supabaseAdmin
        .from("task_templates")
        .select("*")
        .eq("lead_type", leadType)
        .eq("is_deleted", false)
        .eq("is_default", true)
        .order("order_index", { ascending: true });

      if (taskTemplates && taskTemplates.length > 0) {
        const isCoPurchaser = !!lead.parent_lead_id;

        const taskRows = taskTemplates.map((tt) => ({
          deal_id: dealId,
          title: tt.name,
          status: "Pending",
          role_type: tt.role_type ?? "Client",
          task_template_id: tt.id,
          is_shared: tt.is_shared ?? false,
          milestone_id: tt.stage_template_id ? (stageToMilestone[tt.stage_template_id] ?? null) : null,
        }));

        const templateIds = taskRows.map((r) => r.task_template_id).filter(Boolean);
        const { data: existingTasks } = await supabaseAdmin
          .from("tasks")
          .select("task_template_id")
          .eq("deal_id", dealId)
          .in("task_template_id", templateIds);

        const existingTemplateIds = new Set((existingTasks ?? []).map((t) => t.task_template_id));
        const dedupedRows = taskRows
          .filter((r) => !r.task_template_id || !existingTemplateIds.has(r.task_template_id))
          .filter((r) => !isCoPurchaser || !r.is_shared);

        if (dedupedRows.length > 0) {
          await supabaseAdmin.from("tasks").insert(dedupedRows);
        }
      }
    } catch (err) {
      console.error("[Convert] Failed to copy task templates (non-blocking):", err);
    }

    // ── Sync shared tasks from linked deals ──────────────────────────────────
    try {
      const parentLeadId = lead.parent_lead_id;
      const currentLeadId = lead.id;

      let linkedLeadIds: string[] = [];

      if (parentLeadId) {
        linkedLeadIds.push(parentLeadId);
        const { data: siblings } = await supabaseAdmin
          .from("leads")
          .select("id")
          .eq("parent_lead_id", parentLeadId)
          .neq("id", currentLeadId);
        if (siblings) linkedLeadIds.push(...siblings.map((s) => s.id));
      } else {
        const { data: coPurchasers } = await supabaseAdmin
          .from("leads")
          .select("id")
          .eq("parent_lead_id", currentLeadId);
        if (coPurchasers) linkedLeadIds.push(...coPurchasers.map((c) => c.id));
      }

      if (linkedLeadIds.length > 0) {
        const { data: linkedDeals } = await supabaseAdmin
          .from("deals")
          .select("id")
          .in("lead_id", linkedLeadIds);

        if (linkedDeals && linkedDeals.length > 0) {
          const linkedDealIds = linkedDeals.map((d) => d.id);

          const { data: completedSharedTasks } = await supabaseAdmin
            .from("tasks")
            .select("task_template_id, status, completed, completed_at")
            .in("deal_id", linkedDealIds)
            .eq("is_shared", true)
            .eq("completed", true);

          if (completedSharedTasks && completedSharedTasks.length > 0) {
            for (const sharedTask of completedSharedTasks) {
              if (sharedTask.task_template_id) {
                await supabaseAdmin
                  .from("tasks")
                  .update({
                    status: "Completed",
                    completed: true,
                    completed_at: sharedTask.completed_at ?? new Date().toISOString(),
                  })
                  .eq("deal_id", dealId)
                  .eq("task_template_id", sharedTask.task_template_id)
                  .eq("is_shared", true);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[Convert] Failed to sync shared tasks (non-blocking):", err);
    }

    // ── Auto-complete APS task if aps_uploaded is already true ─────────────
    try {
      if (lead.aps_uploaded === true) {
        await completeApsTask(dealId);
      }
    } catch (err) {
      console.error("[Convert] Failed to auto-complete APS task (non-blocking):", err);
    }

    // ── Create Supabase Auth user + send invite/reset email via Resend ────
    let authUserId: string | null = null;
    let inviteSent = false;
    let authError: string | null = null;

    try {
      const customerPortalUrl = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://iclosed-customer-application-rosy.vercel.app").replace(/\/+$/, "");
      const redirectTo = `${customerPortalUrl}/api/auth/callback?next=/set-password`;

      const userData = {
        first_name: lead.first_name ?? "",
        last_name: lead.last_name ?? "",
        display_name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(),
      };

      // Check if this client already has a Supabase Auth account from a previous conversion.
      // existingClient.auth_user_id is set during conversion — if present, user is already onboarded.
      const alreadyOnboarded = !!(existingClient?.auth_user_id);

      if (!alreadyOnboarded) {
        // New user — send invite email via Resend
        const inviteResult = await sendAuthEmailViaResend({
          type: "invite",
          email: lead.email,
          redirectTo,
          userData,
        });

        if (inviteResult.success && inviteResult.userId) {
          authUserId = inviteResult.userId;
          inviteSent = true;
          await supabaseAdmin.from("clients").update({ auth_user_id: authUserId }).eq("id", clientId);
        } else if (inviteResult.error) {
          authError = inviteResult.error;
        }
      } else {
        // User already onboarded — link existing auth user, send recovery email instead
        authUserId = existingClient.auth_user_id;

        const resetResult = await sendAuthEmailViaResend({
          type: "recovery",
          email: lead.email,
          redirectTo,
        });

        if (resetResult.success) {
          inviteSent = true;
        } else {
          authError = `Already exists, but reset email failed: ${resetResult.error}`;
        }
      }
    } catch (err: any) {
      authError = err.message || "Unknown auth error";
    }

    return {
      success: true,
      created: true,
      lead_id: leadId,
      deal_id: dealId,
      file_number: generatedFileNumber,
      client_id: clientId,
      invite_sent: inviteSent,
      auth_error: authError,
    };
  } catch (err: any) {
    return {
      success: false,
      created: false,
      lead_id: leadId,
      error: err.message ?? "Unknown error",
      statusCode: 500,
    };
  }
}
