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
 * }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { lead_id, file_number, closing_date } = body;

    if (!lead_id) {
      return NextResponse.json({ success: false, error: "lead_id is required" }, { status: 400 });
    }

    // ── 1. Fetch the lead ─────────────────────────────────────────────────────
    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .single();

    if (leadError || !lead) {
      return NextResponse.json({ success: false, error: "Lead not found" }, { status: 404 });
    }

    // Check that this lead hasn't already been converted
    const { data: existingDeal } = await supabaseAdmin
      .from("deals")
      .select("id, file_number")
      .eq("lead_id", lead_id)
      .maybeSingle();

    if (existingDeal) {
      return NextResponse.json({
        success: false,
        error: `Lead already converted to deal ${existingDeal.file_number}`,
      }, { status: 409 });
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
        return NextResponse.json({ success: false, error: `Failed to create client: ${clientError?.message}` }, { status: 500 });
      }

      clientId = newClient.id;
    }

    // ── 3. Generate file number if not provided ───────────────────────────────
    const leadTypePrefix = lead.lead_type?.charAt(0)?.toUpperCase() ?? "X";
    const year = new Date().getFullYear().toString().slice(-2);
    const shortId = lead_id.substring(0, 4).toUpperCase();
    const generatedFileNumber = file_number ?? `${year}${leadTypePrefix}-${shortId}`;

    // ── 4. Clean price (strip currency formatting) ────────────────────────────
    const rawPrice = lead.price ? String(lead.price).replace(/[^0-9.]/g, "") : null;
    const cleanPrice = rawPrice ? parseFloat(rawPrice) : null;

    // ── 5. Create the deal ────────────────────────────────────────────────────
    const { data: deal, error: dealError } = await supabaseAdmin
      .from("deals")
      .insert({
        lead_id,
        client_id: clientId,
        file_number: generatedFileNumber,
        type: lead.lead_type ?? "Purchase",
        status: "Active",
        property_address: lead.address_street ?? "Address TBD",
        closing_date: closing_date ?? null,
        price: cleanPrice ?? 0,
      })
      .select("id")
      .single();

    if (dealError || !deal) {
      return NextResponse.json({ success: false, error: `Failed to create deal: ${dealError?.message}` }, { status: 500 });
    }

    const dealId = deal.id;

    // ── 6. Copy milestones from stage_templates ───────────────────────────────
    const leadType = lead.lead_type ?? "Purchase";

    const { data: stages } = await supabaseAdmin
      .from("stage_templates")
      .select("id, name, order_index")
      .eq("lead_type", leadType)
      .order("order_index", { ascending: true });

    const milestoneMap: Record<string, string> = {}; // stage_template_id → milestone_id

    if (stages && stages.length > 0) {
      for (const stage of stages) {
        const cleanName = stage.name?.trim().replace(/^\t+/, "").replace(/^->?\s*/, "") ?? stage.name;

        const { data: ms } = await supabaseAdmin
          .from("milestones")
          .insert({
            deal_id: dealId,
            title: cleanName,
            status: stage.order_index === 1 ? "In Progress" : "Pending",
            order_index: stage.order_index,
          })
          .select("id")
          .single();

        if (ms) milestoneMap[stage.id] = ms.id;
      }
    }

    // ── 7. Copy tasks from task_templates ─────────────────────────────────────
    const { data: taskTemplates } = await supabaseAdmin
      .from("task_templates")
      .select("id, name, role_type, order_index, deadline_rule")
      .eq("lead_type", leadType)
      .order("order_index", { ascending: true });

    if (taskTemplates && taskTemplates.length > 0) {
      // Find first milestone to assign tasks to by default
      const firstMilestoneId = Object.values(milestoneMap)[0] ?? null;

      // Extract milestone names for matching
      const milestoneNameToId: Record<string, string> = {};
      if (stages) {
        for (const stage of stages) {
          const cleanName = stage.name?.trim().replace(/^\t+/, "").replace(/^->?\s*/, "") ?? stage.name;
          if (milestoneMap[stage.id]) {
            milestoneNameToId[cleanName] = milestoneMap[stage.id];
          }
        }
      }

      const getMilestoneForTask = (taskName: string) => {
        const tLower = taskName.trim().toLowerCase();
        for (const [mName, mId] of Object.entries(milestoneNameToId)) {
          const mLower = mName.trim().toLowerCase();
          if (tLower === mLower || tLower.includes(mLower) || mLower.includes(tLower)) return mId;
          
          if (tLower.includes("personal") && mLower.includes("personal")) return mId;
          if (tLower.includes("identifi") && mLower.includes("identifi")) return mId;
          if (tLower.includes("insurance") && mLower.includes("insurance")) return mId;
          if (tLower.includes("appointment") && mLower.includes("appointment")) return mId;
          if (tLower.includes("agreement of purchase") && mLower.includes("agreement of purchase")) return mId;
          if (tLower.includes("mortgage") && mLower.includes("mortgage")) return mId;
        }
        return firstMilestoneId;
      };

      const taskRows = taskTemplates
        .filter((t) => {
          const role = (t.role_type ?? "").toLowerCase();
          return role === "client" || role === "both" || role === "";
        })
        .map((t) => {
          const cleanTitle = t.name?.trim() ?? t.name;
          return {
            deal_id: dealId,
            milestone_id: getMilestoneForTask(cleanTitle),
            task_template_id: t.id,
            title: cleanTitle,
            status: "Pending",
            completed: false,
          };
        });

      if (taskRows.length > 0) {
        await supabaseAdmin.from("tasks").insert(taskRows);
      }
    }

    // ── 8. Create Supabase Auth user + send invite email ──────────────────────
    let authUserId: string | null = null;
    let inviteSent = false;

    try {
      // inviteUserByEmail sends a magic link — client sets their password via the email
      // We read the customer portal URL from the admin portal's env variable
      const customerPortalUrl = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "http://localhost:3000").replace(/\/+$/, "");

      const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        lead.email,
        {
          redirectTo: `${customerPortalUrl}/set-password`,
        }
      );

      if (!inviteError && inviteData?.user) {
        authUserId = inviteData.user.id;
        inviteSent = true;

        // Link the auth user to the client record
        await supabaseAdmin
          .from("clients")
          .update({ auth_user_id: authUserId })
          .eq("id", clientId);
      } else if (inviteError && inviteError.code === "user_already_exists") {
        // User already exists in the system.
        console.log("User already exists, attempting to link and send reset/magic link instead.");
        
        // 1. Find the user ID
        const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = existingUsers.users.find(u => u.email === lead.email.toLowerCase());
        
        if (existingUser) {
          authUserId = existingUser.id;
          
          await supabaseAdmin
            .from("clients")
            .update({ auth_user_id: authUserId })
            .eq("id", clientId);

          // 2. See if they need a password set. 
          // If they already exist but we are dealing with a new lead, sending them a password reset 
          // serves as a "Welcome back, set your password if you forgot it, or login" trigger.
          const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(
            lead.email, 
            { redirectTo: `${customerPortalUrl}/set-password` }
          );

          if (!resetError) {
             inviteSent = true;
          }
        }
      } else {
        console.warn("Auth invite warning:", inviteError?.message);
      }
    } catch (err) {
      // Auth invite failing should not block deal creation
      console.error("Auth invite failed (non-blocking):", err);
    }

    // ── 9. Update lead status ──────────────────────────────────────────────────
    await supabaseAdmin
      .from("leads")
      .update({ status: "Converted" })
      .eq("id", lead_id);

    return NextResponse.json({
      success: true,
      deal_id: dealId,
      file_number: generatedFileNumber,
      client_id: clientId,
      invite_sent: inviteSent,
      message: inviteSent
        ? `Deal created and invite email sent to ${lead.email}`
        : `Deal created. Auth invite could not be sent — create login manually.`,
    });
  } catch (err) {
    console.error("POST /api/admin/convert-lead error:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
