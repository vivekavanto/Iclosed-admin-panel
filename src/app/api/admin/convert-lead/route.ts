import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

/**
 * POST /api/admin/convert-lead
 *
 * Called by the admin panel when an admin converts a lead to a deal.
 * This endpoint:
 *   1. Creates / finds a client record
 *   2. Creates a deal linked to the client + lead
 *   3. Copies milestones from stage_templates
 *   4. Copies tasks from task_templates
 *   5. Creates a Supabase Auth user (invite email sent automatically)
 *   6. Links auth_user_id to the client record
 *
 * Expects body:
 * {
 *   lead_id: string,
 *   file_number?: string,   // e.g. "26P-0059"  (optional, auto-generated if missing)
 *   closing_date?: string,  // ISO string e.g. "2026-05-15"
 *   convert_family?: boolean // when true, converts the whole co-purchaser family
 * }
 */

type ConvertOneResult = {
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

async function convertSingleLeadToDeal(
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

      // Idempotency: still mark lead as converted (in case it wasn't updated).
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

    // ── 2. Create or find client record ───────────────────────────────────────
    let clientId: string;

    const { data: existingClient } = await supabaseAdmin
      .from("clients")
      .select("id")
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

    // ── 3. Generate file number if not provided ───────────────────────────────
    const leadTypePrefix = lead.lead_type?.charAt(0)?.toUpperCase() ?? "X";
    const year = new Date().getFullYear().toString().slice(-2);
    const prefix = `${year}${leadTypePrefix}-`;

    let generatedFileNumber = opts.file_number;
    if (!generatedFileNumber) {
      // Get ALL file numbers with this prefix to find the true max numerically
      const { data: allDeals } = await supabaseAdmin
        .from("deals")
        .select("file_number")
        .like("file_number", `${prefix}%`);

      let maxNum = 0;
      if (allDeals) {
        for (const d of allDeals) {
          const suffix = d.file_number.replace(prefix, "");
          // Only count purely numeric suffixes (skip old UUID-based ones like "A3F2")
          if (!/^\d+$/.test(suffix)) continue;
          const numPart = parseInt(suffix, 10);
          if (!isNaN(numPart) && numPart > maxNum) maxNum = numPart;
        }
      }

      // Try incrementing from max, retry if collision (race condition safety)
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
        // Fallback: use timestamp-based suffix to guarantee uniqueness
        generatedFileNumber = `${prefix}${String(maxNum + 100).padStart(4, "0")}`;
      }
    }

    // If admin provided a custom file number, verify it's unique
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

    // ── 4. Clean price (strip currency formatting) ────────────────────────────
    const rawPrice = lead.price ? String(lead.price).replace(/[^0-9.]/g, "") : null;
    const cleanPrice = rawPrice ? parseFloat(rawPrice) : null;

    // ── 5. Create the deal ────────────────────────────────────────────────────
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

    // ── 6. Copy stage_templates → milestones ────────────────────────────────
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

        console.log(`[Convert] Created ${milestones?.length ?? 0} milestones for deal ${dealId}`);
      }
    } catch (err) {
      console.error("[Convert] Failed to copy stage templates (non-blocking):", err);
    }

    // ── 7. Copy task_templates → tasks (only is_default = true) ─────────────
    try {
      const { data: taskTemplates } = await supabaseAdmin
        .from("task_templates")
        .select("*")
        .eq("lead_type", leadType)
        .eq("is_deleted", false)
        .eq("is_default", true)
        .order("order_index", { ascending: true });

      if (taskTemplates && taskTemplates.length > 0) {
        // Co-purchasers should not get their own shared tasks; shared tasks live on the primary deal.
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

        // Avoid duplicate shared tasks (deal_id + task_template_id)
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

        console.log(
          `[Convert] Created ${dedupedRows.length} tasks for deal ${dealId} (${taskRows.length - dedupedRows.length} skipped as duplicates)`,
        );
      }
    } catch (err) {
      console.error("[Convert] Failed to copy task templates (non-blocking):", err);
    }

    // ── 7b. Sync shared tasks from linked deals (co-purchaser flow) ──────────
    try {
      // Check if this lead has a parent (is a co-purchaser) or has co-purchasers
      const parentLeadId = lead.parent_lead_id;
      const currentLeadId = lead.id;

      // Collect all linked lead IDs (parent + siblings)
      let linkedLeadIds: string[] = [];

      if (parentLeadId) {
        // This lead is a co-purchaser — find the parent's deal and any sibling co-purchaser deals
        linkedLeadIds.push(parentLeadId);
        const { data: siblings } = await supabaseAdmin
          .from("leads")
          .select("id")
          .eq("parent_lead_id", parentLeadId)
          .neq("id", currentLeadId);
        if (siblings) linkedLeadIds.push(...siblings.map((s) => s.id));
      } else {
        // This lead might be a primary — find co-purchaser deals
        const { data: coPurchasers } = await supabaseAdmin
          .from("leads")
          .select("id")
          .eq("parent_lead_id", currentLeadId);
        if (coPurchasers) linkedLeadIds.push(...coPurchasers.map((c) => c.id));
      }

      if (linkedLeadIds.length > 0) {
        // Find deals for the linked leads
        const { data: linkedDeals } = await supabaseAdmin
          .from("deals")
          .select("id")
          .in("lead_id", linkedLeadIds);

        if (linkedDeals && linkedDeals.length > 0) {
          const linkedDealIds = linkedDeals.map((d) => d.id);

          // Find completed shared tasks in linked deals
          const { data: completedSharedTasks } = await supabaseAdmin
            .from("tasks")
            .select("task_template_id, status, completed, completed_at")
            .in("deal_id", linkedDealIds)
            .eq("is_shared", true)
            .eq("completed", true);

          if (completedSharedTasks && completedSharedTasks.length > 0) {
            // Update matching shared tasks in the newly created deal
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
            console.log(`[Convert] Synced ${completedSharedTasks.length} shared tasks from linked deals`);
          }
        }
      }
    } catch (err) {
      console.error("[Convert] Failed to sync shared tasks (non-blocking):", err);
    }

    // ── 8. Create Supabase Auth user + send invite email ──────────────────────
    let authUserId: string | null = null;
    let inviteSent = false;
    let authError: string | null = null;

    try {
      // inviteUserByEmail sends a magic link — client sets their password via the email
      // We read the customer portal URL from the admin portal's env variable
      const customerPortalUrl = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://iclosed-customer-application-rosy.vercel.app").replace(/\/+$/, "");

      console.log(`[Inviting User] Email: ${lead.email}, Redirect: ${customerPortalUrl}/set-password`);

      const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        lead.email,
        {
          redirectTo: `${customerPortalUrl}/api/auth/callback?next=/set-password`,
          data: {
            first_name: lead.first_name ?? "",
            last_name: lead.last_name ?? "",
            display_name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(),
          },
        },
      );

      if (!inviteError && inviteData?.user) {
        authUserId = inviteData.user.id;
        inviteSent = true;

        // Link the auth user to the client record
        await supabaseAdmin.from("clients").update({ auth_user_id: authUserId }).eq("id", clientId);
      } else if (inviteError && inviteError.code === "user_already_exists") {
        // User already exists in the system.
        console.log(`[Invite] User ${lead.email} already exists, attempting to link and send reset link instead.`);

        // 1. Find the user ID
        const { data: usersData } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = usersData.users.find(
          (u: any) => u.email?.toLowerCase() === lead.email.toLowerCase(),
        );

        if (existingUser) {
          authUserId = existingUser.id;

          await supabaseAdmin.from("clients").update({ auth_user_id: authUserId }).eq("id", clientId);

          // 2. Send password reset link which acts as a "set password" flow if they haven't set one
          const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(
            lead.email,
            { redirectTo: `${customerPortalUrl}/api/auth/callback?next=/set-password` },
          );

          if (!resetError) {
            inviteSent = true;
          } else {
            authError = `Already exists, but reset email failed: ${resetError.message}`;
            console.error("[Invite] Reset failed:", resetError.message);
          }
        }
      } else if (inviteError) {
        authError = inviteError.message;
        console.warn("[Invite Error] Supabase rejected invite:", inviteError.message);
      }
    } catch (err: any) {
      // Auth invite failing should not block deal creation
      authError = err.message || "Unknown auth error";
      console.error("[Invite Exception] Invite failed (non-blocking):", err);
    }

    // ── 7. Update lead status ──────────────────────────────────────────────────
    await supabaseAdmin.from("leads").update({ status: "Converted" }).eq("id", leadId);

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
      lead_id: lead.id,
      statusCode: 500,
      error: err?.message ?? "Unknown conversion error",
    };
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { lead_id, file_number, closing_date, convert_family } = body as {
      lead_id: string;
      file_number?: string;
      closing_date?: string;
      convert_family?: boolean;
    };

    if (!lead_id) {
      return NextResponse.json({ success: false, error: "lead_id is required" }, { status: 400 });
    }

    // ── 1. Fetch the lead ─────────────────────────────────────────────────────
    const { data: selectedLead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .single();

    if (leadError || !selectedLead) {
      return NextResponse.json({ success: false, error: "Lead not found" }, { status: 404 });
    }

    // ── Auto-link address-matched leads before conversion ────────────────────
    // If any leads have address_match_flag pointing to this lead but no parent_lead_id,
    // link them now so they're included in family conversion.
    try {
      const { data: pendingMatches } = await supabaseAdmin
        .from("leads")
        .select("id, email, address_match_flag")
        .is("parent_lead_id", null)
        .not("address_match_flag", "is", null);

      if (pendingMatches) {
        for (const pm of pendingMatches) {
          const matchedId = pm.address_match_flag?.matched_lead_id;
          if (!matchedId) continue;

          // Get matched lead's email and parent_lead_id
          const { data: matchedLead } = await supabaseAdmin
            .from("leads")
            .select("email, parent_lead_id")
            .eq("id", matchedId)
            .single();

          if (!matchedLead) continue;

          // Only auto-link if emails are different (different person, same address)
          if (matchedLead.email?.toLowerCase() === pm.email?.toLowerCase()) {
            // Same email — just clear the flag
            await supabaseAdmin
              .from("leads")
              .update({ address_match_flag: null })
              .eq("id", pm.id);
            continue;
          }

          const rootId = matchedLead.parent_lead_id ?? matchedId;

          await supabaseAdmin
            .from("leads")
            .update({ parent_lead_id: rootId, address_match_flag: null })
            .eq("id", pm.id);
        }

        // Re-fetch the selected lead in case it was updated
        const { data: refreshedLead } = await supabaseAdmin
          .from("leads")
          .select("*")
          .eq("id", lead_id)
          .single();
        if (refreshedLead) Object.assign(selectedLead, refreshedLead);
      }
    } catch {
      // Non-blocking
    }

    // ── Check if this lead has family (auto-detect convert_family) ──────────
    const autoDetectFamily = !convert_family;
    let effectiveConvertFamily = convert_family ?? false;

    if (autoDetectFamily) {
      const rootId = selectedLead.parent_lead_id ?? selectedLead.id;
      const { data: familyCheck } = await supabaseAdmin
        .from("leads")
        .select("id")
        .or(`id.eq.${rootId},parent_lead_id.eq.${rootId}`);
      if (familyCheck && familyCheck.length > 1) {
        effectiveConvertFamily = true;
      }
    }

    // ── Single-lead conversion (no family) ──────────────────────────────────
    if (!effectiveConvertFamily) {
      const one = await convertSingleLeadToDeal(selectedLead, {
        file_number,
        closing_date,
        existingDealBehavior: "error",
      });

      if (!one.success) {
        return NextResponse.json(
          { success: false, error: one.error ?? "Conversion failed" },
          { status: one.statusCode ?? 500 },
        );
      }

      return NextResponse.json({
        success: true,
        deal_id: one.deal_id,
        file_number: one.file_number,
        client_id: one.client_id,
        invite_sent: one.invite_sent ?? false,
        auth_error: one.auth_error ?? null,
        message: one.invite_sent
          ? `Deal created and invite email sent to ${selectedLead.email}`
          : `Deal created, but invite could not be sent: ${one.auth_error || "Create login manually"}`,
      });
    }

    // ── Family conversion ───────────────────────────────────────────────────
    const rootLeadId: string = selectedLead.parent_lead_id ?? selectedLead.id;

    const { data: familyLeads, error: familyLeadsError } = await supabaseAdmin
      .from("leads")
      .select("*")
      .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

    if (familyLeadsError || !familyLeads || familyLeads.length === 0) {
      return NextResponse.json(
        { success: false, error: familyLeadsError?.message ?? "Co-purchaser family not found" },
        { status: 404 },
      );
    }

    const results: ConvertOneResult[] = [];
    let failedCount = 0;

    // Important: apply the admin-provided `file_number` only to the root/primary lead.
    for (const lead of familyLeads) {
      const fileOverride = lead.id === rootLeadId ? file_number : undefined;
      const res = await convertSingleLeadToDeal(lead, {
        file_number: fileOverride,
        closing_date,
        existingDealBehavior: "skip",
      });
      results.push(res);
      if (!res.success) failedCount++;
    }

    const created_count = results.filter((r) => r.created).length;
    const skipped_count = results.length - created_count;
    const invites_sent_count = results.filter((r) => r.invite_sent).length;

    const rootResult = results.find((r) => r.lead_id === rootLeadId);

    return NextResponse.json({
      success: failedCount === 0,
      had_errors: failedCount > 0,
      failed_count: failedCount,
      created_count,
      skipped_count,
      invites_sent_count,
      results,
      deal_id: rootResult?.deal_id ?? null,
      file_number: rootResult?.file_number ?? null,
      client_id: rootResult?.client_id ?? null,
    });
  } catch (err) {
    console.error("POST /api/admin/convert-lead error:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
