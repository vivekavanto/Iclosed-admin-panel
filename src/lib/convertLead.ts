import supabaseAdmin from "./supabaseAdmin";
import { completeApsTask } from "./completeApsTask";
import { sendAuthEmailViaResend } from "./sendAuthEmail";
import { getFamilyDealIds } from "./familyDeals";
import { recalcMilestonesForFamily } from "./recalcMilestones";
import { sendWelcomeEmail } from "./sendWelcomeEmail";

export type ConvertOneResult = {
  success: boolean;
  created: boolean;
  lead_id: string;
  already_converted?: boolean;
  deal_id?: string;
  file_number?: string;
  client_id?: string;
  invite_sent?: boolean;
  already_has_login?: boolean;
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
    // Check if this lead has already been converted. We use a list query so
    // multiple rows (an unintended state) don't silently make .maybeSingle()
    // return null — which would let the function continue and create yet
    // another deal.
    const { data: existingDeals } = await supabaseAdmin
      .from("deals")
      .select("id, file_number, client_id, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    const existingDeal = (existingDeals ?? [])[0];

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
        already_converted: true,
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
    const ltLower = (lead.lead_type ?? "").toLowerCase();
    const isCombinedPS = ltLower.includes("purchase") && ltLower.includes("sale");
    const leadTypePrefix = isCombinedPS
      ? "PS"
      : (lead.lead_type?.charAt(0)?.toUpperCase() ?? "X");
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
        // New deals start as "Inactive" — a Postgres trigger
        // (activate_deals_on_first_signin) flips this to "Active" the first
        // time the linked client signs in to the portal.
        status: "Inactive",
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

    // A lead can be a combined type like "Purchase & Sale" — split into parts so
    // we seed milestones/tasks from every constituent lead type, preserving the
    // order the parts appeared in (e.g. Purchase rows before Sale rows).
    const leadTypeParts = leadType
      .split(/\s*(?:&|\band\b|\+|\/)\s*/i)
      .map((s: string) => s.trim())
      .filter(Boolean);
    const leadTypePartIndex = (lt: string | null | undefined): number => {
      if (!lt) return Number.MAX_SAFE_INTEGER;
      const idx = leadTypeParts.findIndex(
        (p: string) => p.toLowerCase() === lt.toLowerCase(),
      );
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };

    await supabaseAdmin.from("leads").update({ status: "Converted" }).eq("id", leadId);

    // ── Copy stage_templates → milestones ────────────────────────────────────
    const stageToMilestone: Record<string, string> = {};

    try {
      const { data: stageTemplatesRaw } = await supabaseAdmin
        .from("stage_templates")
        .select("*")
        .in("lead_type", leadTypeParts)
        .order("order_index", { ascending: true });

      // Group by lead_type in the order specified by leadTypeParts so combined
      // deals show Purchase milestones first, then Sale, etc.
      const stageTemplatesSorted = (stageTemplatesRaw ?? []).slice().sort((a, b) => {
        const ai = leadTypePartIndex(a.lead_type);
        const bi = leadTypePartIndex(b.lead_type);
        if (ai !== bi) return ai - bi;
        return (a.order_index ?? 0) - (b.order_index ?? 0);
      });

      // Dedupe by name *within each lead_type only*. Keeps each workflow
      // distinct: a name like "Funds Received" can appear once for Purchase
      // and once for Sale (separate rows, each tagged with their own
      // lead_type), so the Sale tab still shows its workflow's items.
      const stageTemplates = (() => {
        const seenByLeadType = new Map<string, Set<string>>();
        return stageTemplatesSorted.filter((st) => {
          const lt = (st.lead_type ?? "").toLowerCase().trim();
          const key = (st.name ?? "").toLowerCase().trim();
          if (!key) return true;
          if (!seenByLeadType.has(lt)) seenByLeadType.set(lt, new Set());
          const seen = seenByLeadType.get(lt)!;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      })();

      if (stageTemplates && stageTemplates.length > 0) {
        const now = new Date().toISOString();
        const allMilestoneRows = stageTemplates.map((st) => ({
          deal_id: dealId,
          title: st.name,
          status: st.auto_complete ? "Completed" : "Pending",
          completed_at: st.auto_complete ? now : null,
          order_index: st.order_index,
          email_template_id: st.email_template_id ?? null,
          stage_template_id: st.id,
          description: st.description ?? null,
        }));

        // Idempotent guard: skip rows whose stage_template_id is already on the
        // deal. Match strictly by template id (not by title) so a Purchase &
        // Sale deal can correctly hold a Purchase row AND a Sale row that
        // happen to share a name like "Funds Received".
        const { data: existingMs } = await supabaseAdmin
          .from("milestones")
          .select("id, stage_template_id")
          .eq("deal_id", dealId);

        const existingStageIds = new Set(
          (existingMs ?? []).map((m) => m.stage_template_id).filter(Boolean),
        );

        // Pre-populate stageToMilestone for any already-existing milestones so
        // task seeding below can still link to them.
        for (const m of existingMs ?? []) {
          if (m.stage_template_id) stageToMilestone[m.stage_template_id] = m.id;
        }

        const milestoneRows = allMilestoneRows.filter((r) => {
          if (r.stage_template_id && existingStageIds.has(r.stage_template_id)) return false;
          return true;
        });

        if (milestoneRows.length === 0) {
          // Nothing new to insert — already-seeded deal. Continue to task step
          // where the same idempotent check applies.
        }

        const { data: milestones, error: msError } = milestoneRows.length > 0
          ? await supabaseAdmin
              .from("milestones")
              .insert(milestoneRows)
              .select("id, stage_template_id")
          : { data: [], error: null };

        if (!msError && milestones) {
          const stageTemplateMap = new Map(stageTemplates.map((st) => [st.id, st]));

          for (const ms of milestones) {
            if (ms.stage_template_id) {
              stageToMilestone[ms.stage_template_id] = ms.id;

              // Send email for auto-completed milestones that have an email template
              const st = stageTemplateMap.get(ms.stage_template_id);
              if (st?.auto_complete && st?.email_template_id) {
                try {
                  // Fetch the email template
                  const { data: emailTemplate } = await supabaseAdmin
                    .from("email_templates")
                    .select("name, subject, body, is_active")
                    .eq("id", st.email_template_id)
                    .single();

                  // Strict is_active check — skip the auto-complete email if
                  // admin disabled this template. Milestone stays completed.
                  if (emailTemplate && !emailTemplate.is_active) {
                    console.log(
                      `[Convert] Auto-complete email skipped — template "${emailTemplate.name}" is inactive. milestone=${ms.id}`,
                    );
                  } else if (emailTemplate?.body) {
                    // Fetch client info
                    const { data: clientData } = await supabaseAdmin
                      .from("clients")
                      .select("email, first_name, last_name")
                      .eq("id", clientId)
                      .single();

                    if (clientData?.email) {
                      const { Resend } = await import("resend");
                      const resend = new Resend(process.env.RESEND_API_KEY);
                      const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <noreply@iclosed.ca>";

                      const fullName = `${clientData.first_name ?? ""} ${clientData.last_name ?? ""}`.trim();
                      const leadAddress = [lead.address_street, lead.address_city, lead.address_province, lead.address_postal_code].filter(Boolean).join(", ");

                      // Replace placeholders in body
                      let processedBody = emailTemplate.body
                        .replace(/&#123;/g, "{").replace(/&#125;/g, "}").replace(/&nbsp;/g, " ").replace(/\u00A0/g, " ");

                      const placeholders: Record<string, string> = {
                        "{{ user.first_name }}": clientData.first_name ?? "",
                        "{{ user.last_name }}": clientData.last_name ?? "",
                        "{{ user.full_name }}": fullName,
                        "{{ user.get_full_name }}": fullName,
                        "{{ user.email }}": clientData.email,
                        "{{ lead_address }}": leadAddress,
                        "{{ lead.address_line1 }}": lead.address_street ?? "",
                        "{{ lead.address_city }}": lead.address_city ?? "",
                        "{{ lead.address_province }}": lead.address_province ?? "",
                        "{{ lead.file_number }}": generatedFileNumber ?? "",
                        "{{ lead_type }}": (leadType ?? "").toLowerCase(),
                        "{{ stage_name }}": st.name ?? "",
                        "{{user.first_name}}": clientData.first_name ?? "",
                        "{{user.last_name}}": clientData.last_name ?? "",
                        "{{user.full_name}}": fullName,
                        "{{user.get_full_name}}": fullName,
                        "{{user.email}}": clientData.email,
                        "{{lead_address}}": leadAddress,
                        "{{lead.address_line1}}": lead.address_street ?? "",
                        "{{lead.address_city}}": lead.address_city ?? "",
                        "{{lead.address_province}}": lead.address_province ?? "",
                        "{{lead.file_number}}": generatedFileNumber ?? "",
                        "{{lead_type}}": (leadType ?? "").toLowerCase(),
                        "{{stage_name}}": st.name ?? "",
                      };
                      for (const [key, value] of Object.entries(placeholders)) {
                        processedBody = processedBody.replaceAll(key, value);
                      }
                      // Whitespace-tolerant regex fallbacks — catches stray
                      // template values like "{{  user.get_full_name  }}".
                      processedBody = processedBody.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, fullName);
                      processedBody = processedBody.replace(/\{\{\s*user\.full_name\s*\}\}/gi, fullName);
                      processedBody = processedBody.replace(/\{\{\s*user\.first_name\s*\}\}/gi, clientData.first_name ?? "");
                      processedBody = processedBody.replace(/\{\{\s*user\.last_name\s*\}\}/gi, clientData.last_name ?? "");
                      processedBody = processedBody.replace(/\{\{\s*user\.email\s*\}\}/gi, clientData.email ?? "");
                      processedBody = processedBody.replace(/\{\{\s*lead_address\s*\}\}/gi, leadAddress);
                      processedBody = processedBody.replace(/\{\{\s*lead\.address_line1\s*\}\}/gi, lead.address_street ?? "");
                      processedBody = processedBody.replace(/\{\{\s*lead\.address_city\s*\}\}/gi, lead.address_city ?? "");
                      processedBody = processedBody.replace(/\{\{\s*lead\.address_province\s*\}\}/gi, lead.address_province ?? "");
                      processedBody = processedBody.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, generatedFileNumber ?? "");
                      processedBody = processedBody.replace(/\{\{\s*lead_type\s*\}\}/gi, (leadType ?? "").toLowerCase());
                      processedBody = processedBody.replace(/\{\{\s*stage_name\s*\}\}/gi, st.name ?? "");

                      // Replace placeholders in subject — derived from template only.
                      let processedSubject = (emailTemplate.subject || emailTemplate.name)
                        .replace(/&#123;/g, "{").replace(/&#125;/g, "}");
                      for (const [key, value] of Object.entries(placeholders)) {
                        processedSubject = processedSubject.replaceAll(key, value);
                      }

                      // No HTML wrapper / logo injection — the DB template owns its layout.
                      const htmlBody = processedBody;

                      await resend.emails.send({
                        from: fromEmail,
                        replyTo: "iclosed@navawilson.law",
                        to: [clientData.email],
                        subject: processedSubject,
                        html: htmlBody,
                      });

                      // Mark email_sent on the milestone
                      await supabaseAdmin
                        .from("milestones")
                        .update({ email_sent: true })
                        .eq("id", ms.id);
                    }
                  }
                } catch (emailErr) {
                  console.error("[Convert] Auto-complete email failed (non-blocking):", emailErr);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[Convert] Failed to copy stage templates (non-blocking):", err);
    }

    // ── Copy task_templates → tasks ──────────────────────────────────────────
    try {
      const { data: taskTemplatesRaw } = await supabaseAdmin
        .from("task_templates")
        .select("*")
        .in("lead_type", leadTypeParts)
        .eq("is_deleted", false)
        .eq("is_default", true)
        .order("order_index", { ascending: true });

      // Group by lead_type in the order specified by leadTypeParts so combined
      // deals show Purchase tasks first, then Sale, etc.
      const taskTemplatesSorted = (taskTemplatesRaw ?? []).slice().sort((a, b) => {
        const ai = leadTypePartIndex(a.lead_type);
        const bi = leadTypePartIndex(b.lead_type);
        if (ai !== bi) return ai - bi;
        return (a.order_index ?? 0) - (b.order_index ?? 0);
      });

      // Dedupe by name within each lead_type only — a Purchase & Sale deal
      // gets a Purchase-tagged copy AND a Sale-tagged copy of any name that
      // exists in both template sets. Strict per-tab filtering in the UI
      // keeps each tab clean.
      const taskTemplates = (() => {
        const seenByLeadType = new Map<string, Set<string>>();
        return taskTemplatesSorted.filter((tt) => {
          const lt = (tt.lead_type ?? "").toLowerCase().trim();
          const key = (tt.name ?? "").toLowerCase().trim();
          if (!key) return true;
          if (!seenByLeadType.has(lt)) seenByLeadType.set(lt, new Set());
          const seen = seenByLeadType.get(lt)!;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      })();

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

        // Idempotent guard: skip rows whose task_template_id is already on the
        // deal. Match by template id only — a Purchase & Sale deal can hold
        // a Purchase task AND a Sale task with the same name (e.g. "Provide
        // Personal Information") because they're tagged with different
        // lead_types and shown on separate tabs.
        const { data: existingTasks } = await supabaseAdmin
          .from("tasks")
          .select("task_template_id")
          .eq("deal_id", dealId);

        const existingTemplateIds = new Set(
          (existingTasks ?? []).map((t) => t.task_template_id).filter(Boolean),
        );

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

            // Recalculate milestones after syncing completed shared tasks
            try {
              const familyDealIds = await getFamilyDealIds(dealId);
              // Resolve the actual primary deal (root lead's deal)
              const rootLeadId = lead.parent_lead_id ?? lead.id;
              const { data: rootDeal } = await supabaseAdmin
                .from("deals")
                .select("id")
                .eq("lead_id", rootLeadId)
                .maybeSingle();
              const primaryId = rootDeal?.id ?? dealId;
              await recalcMilestonesForFamily(familyDealIds, primaryId);
            } catch {
              // Non-blocking
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

    // ── Create Supabase Auth user + send invite email via Resend ─────────
    let authUserId: string | null = null;
    let inviteSent = false;
    let alreadyHasLogin = false;
    let authError: string | null = null;

    try {
      // If client already has a Supabase Auth account, skip invite — no recovery email either.
      const alreadyOnboarded = !!(existingClient?.auth_user_id);

      if (alreadyOnboarded) {
        // User already has portal login — just link, no email
        authUserId = existingClient.auth_user_id;
        alreadyHasLogin = true;
      } else {
        // New user — send invite email via Resend
        const customerPortalUrl = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://www.iclosed.ca/").replace(/\/+$/, "");
        const redirectTo = `${customerPortalUrl}/api/auth/callback?next=/set-password`;

        const userData = {
          first_name: lead.first_name ?? "",
          last_name: lead.last_name ?? "",
          display_name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(),
        };

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
      }
    } catch (err: any) {
      authError = err.message || "Unknown auth error";
    }

    // ── Send welcome email on conversion ─────────────────────────────────
    // Fires for every converted client (new or returning). Idempotent —
    // sendWelcomeEmail checks leads.welcome_email_sent, so this is a no-op
    // if the email already went out at intake stage or first login. Failure
    // is non-blocking; the conversion itself is already complete.
    try {
      await sendWelcomeEmail(leadId, { source: "conversion" });
    } catch (welcomeErr) {
      console.error("[Convert] Welcome email failed (non-blocking):", welcomeErr);
    }

    return {
      success: true,
      created: true,
      lead_id: leadId,
      already_converted: false,
      deal_id: dealId,
      file_number: generatedFileNumber,
      client_id: clientId,
      invite_sent: inviteSent,
      already_has_login: alreadyHasLogin,
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
