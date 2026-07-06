import { NextResponse } from "next/server"
import supabaseAdmin from "@/lib/supabaseAdmin"
import { Resend } from "resend"
import { getFamilyDealIds } from "@/lib/familyDeals"
import { formatLeadTypeLabel, buildLeadAddressForEmail } from "@/lib/leadEmailAddress"

/**
 * Sends a milestone email to the client of a single deal.
 * Returns { success, email, error? }
 */
async function sendEmailForDeal(
    dealId: string,
    milestone: any,
    template: any,
    resend: Resend,
    fromEmail: string,
): Promise<{ success: boolean; email?: string; error?: string }> {
    try {
        const { data: deal } = await supabaseAdmin
            .from("deals")
            .select("client_id, lead_id, file_number, property_address, lockbox_code, type, closing_date")
            .eq("id", dealId)
            .single()

        if (!deal?.client_id) return { success: false, error: "Deal or client not found" }

        const { data: client } = await supabaseAdmin
            .from("clients")
            .select("email, first_name, last_name")
            .eq("id", deal.client_id)
            .single()

        if (!client?.email) return { success: false, error: "Client email not found" }

        // Fetch lead data for lead placeholders
        let lead: any = null;
        if (deal.lead_id) {
            const { data: leadData } = await supabaseAdmin
                .from("leads")
                .select("*")
                .eq("id", deal.lead_id)
                .single()
            lead = leadData;
        }

        // Build formatted address — combines purchase + selling for P&S
        // and pulls the missing side from family-sibling leads when needed.
        const leadAddress =
            (await buildLeadAddressForEmail(lead)) || deal.property_address || ""

        // Replace placeholders in email body
        const fullName = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim()
        const leadType = formatLeadTypeLabel(lead?.lead_type ?? deal.type)
        const fileNumber = deal.file_number ?? ""

        // Lock box code is stored per-deal on the primary PURCHASE deal (it's
        // deliberately not mirrored across the family). A co-purchaser's own
        // deal has no code, so fall back to the primary purchaser's deal —
        // it's the same physical property. Sale-side people (co-sellers) never
        // inherit it. `lockboxValue` is bolded for the HTML email; an empty
        // code stays empty so we don't emit an orphan <strong></strong>.
        let lockboxCode = deal.lockbox_code ?? ""
        if (!lockboxCode && lead?.parent_lead_id && lead?.co_person_role === "purchaser") {
            const { data: primaryDeal } = await supabaseAdmin
                .from("deals")
                .select("lockbox_code")
                .eq("lead_id", lead.parent_lead_id)
                .limit(1)
                .maybeSingle()
            lockboxCode = primaryDeal?.lockbox_code ?? ""
        }
        const lockboxValue = lockboxCode ? `<strong>${lockboxCode}</strong>` : ""

        // Short-form / specialty tokens used by some templates (retainer agreement etc.)
        const leadTypeLower = leadType.toLowerCase()
        const sideSuffix = leadTypeLower.includes("purchase") && leadTypeLower.includes("sale")
            ? " (Purchase & Sale)"
            : leadTypeLower === "sale" || (leadTypeLower.includes("sale") && !leadTypeLower.includes("purchase"))
                ? " (Sale)"
                : ""
        const computeRole = (l: any): string => {
            const lt = (l?.lead_type ?? leadType ?? "").toLowerCase().trim();
            const isCombined = lt.includes("purchase") && lt.includes("sale");
            const isSaleOnly = lt === "sale" || (lt.includes("sale") && !lt.includes("purchase"));
            if (l?.parent_lead_id) {
                if (isSaleOnly) return "Co-Seller";
                if (isCombined && l?.selling_address_street) return "Co-Seller";
                if (lt.includes("purchase") && !isSaleOnly) return "Co-Purchaser";
                if (l?.selling_address_street) return "Co-Seller";
                return "Co-Purchaser";
            }
            if (isCombined) return "Purchaser & Seller";
            if (isSaleOnly) return "Seller";
            return "Purchaser";
        }
        const role = computeRole(lead)
        const propertyRoleRow = role ? `Your Role: ${role}` : ""

        // Per-recipient transaction label: a co-person on a Purchase & Sale deal
        // retains us for only one side, so the email shows just that side —
        // Co-Seller → "Sale", Co-Purchaser → "Purchase". The primary client keeps
        // the full "Purchase & Sale" label. Mirrors formatLeadTypeLabelForRecipient
        // in iclosed_web.
        const isPSDeal = leadTypeLower.includes("purchase") && leadTypeLower.includes("sale")
        const displayLeadType =
            isPSDeal && lead?.parent_lead_id
                ? role === "Co-Seller"
                    ? "Sale"
                    : role === "Co-Purchaser"
                        ? "Purchase"
                        : leadType
                : leadType

        const placeholders: Record<string, string> = {
            // User placeholders
            "{{ user.first_name }}": client.first_name ?? "",
            "{{ user.last_name }}": client.last_name ?? "",
            "{{ user.full_name }}": fullName,
            "{{ user.get_full_name }}": fullName,
            "{{ user.email }}": client.email,
            "{{user.first_name}}": client.first_name ?? "",
            "{{user.last_name}}": client.last_name ?? "",
            "{{user.full_name}}": fullName,
            "{{user.get_full_name}}": fullName,
            "{{user.email}}": client.email,
            // Lead / deal placeholders
            "{{ lead_address }}": leadAddress,
            "{{lead_address}}": leadAddress,
            "{{ lead.address_line1 }}": lead?.address_street ?? deal.property_address ?? "",
            "{{lead.address_line1}}": lead?.address_street ?? deal.property_address ?? "",
            "{{ lead.address_city }}": lead?.address_city ?? "",
            "{{lead.address_city}}": lead?.address_city ?? "",
            "{{ lead.address_province }}": lead?.address_province ?? "",
            "{{lead.address_province}}": lead?.address_province ?? "",
            "{{ lead.file_number }}": fileNumber,
            "{{lead.file_number}}": fileNumber,
            "{{ lead_type }}": displayLeadType,
            "{{lead_type}}": displayLeadType,
            // Milestone placeholders
            "{{ stage_name }}": milestone?.title ?? "",
            "{{stage_name}}": milestone?.title ?? "",
            "{{ stage_status }}": milestone?.status ?? "Completed",
            "{{stage_status}}": milestone?.status ?? "Completed",
            // Short-form aliases (retainer agreement and similar templates)
            "{{ first_name }}": client.first_name ?? "",
            "{{ last_name }}": client.last_name ?? "",
            "{{ full_name }}": fullName,
            "{{ email }}": client.email,
            "{{ property_address }}": leadAddress,
            "{{ lockbox_code }}": lockboxValue,
            "{{lockbox_code}}": lockboxValue,
            "{{ lead.lockbox_code }}": lockboxValue,
            "{{lead.lockbox_code}}": lockboxValue,
            "{{ file_number }}": fileNumber,
            "{{ side_suffix }}": sideSuffix,
            "{{ property_role_row }}": propertyRoleRow,
            "{{first_name}}": client.first_name ?? "",
            "{{last_name}}": client.last_name ?? "",
            "{{full_name}}": fullName,
            "{{email}}": client.email,
            "{{property_address}}": leadAddress,
            "{{file_number}}": fileNumber,
            "{{side_suffix}}": sideSuffix,
            "{{property_role_row}}": propertyRoleRow,
        }

        let processedBody = template.body
            .replace(/&#123;/g, "{")
            .replace(/&#125;/g, "}")
            .replace(/&nbsp;/g, " ")
            .replace(/\u00A0/g, " ")
        for (const [key, value] of Object.entries(placeholders)) {
            processedBody = processedBody.replaceAll(key, value)
        }

        // Catch remaining placeholders with flexible whitespace
        processedBody = processedBody.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, fullName);
        processedBody = processedBody.replace(/\{\{\s*user\.first_name\s*\}\}/gi, client.first_name ?? "");
        processedBody = processedBody.replace(/\{\{\s*user\.last_name\s*\}\}/gi, client.last_name ?? "");
        processedBody = processedBody.replace(/\{\{\s*user\.full_name\s*\}\}/gi, fullName);
        processedBody = processedBody.replace(/\{\{\s*user\.email\s*\}\}/gi, client.email ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead_address\s*\}\}/gi, leadAddress);
        processedBody = processedBody.replace(/\{\{\s*lead\.address_line1\s*\}\}/gi, lead?.address_street ?? deal.property_address ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.address_city\s*\}\}/gi, lead?.address_city ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.address_province\s*\}\}/gi, lead?.address_province ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, deal.file_number ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead_type\s*\}\}/gi, displayLeadType);
        processedBody = processedBody.replace(/\{\{\s*stage_name\s*\}\}/gi, milestone?.title ?? "");
        processedBody = processedBody.replace(/\{\{\s*stage_status\s*\}\}/gi, milestone?.status ?? "Completed");
        // Short-form alias fallbacks
        processedBody = processedBody.replace(/\{\{\s*first_name\s*\}\}/gi, client.first_name ?? "");
        processedBody = processedBody.replace(/\{\{\s*last_name\s*\}\}/gi, client.last_name ?? "");
        processedBody = processedBody.replace(/\{\{\s*full_name\s*\}\}/gi, fullName);
        processedBody = processedBody.replace(/\{\{\s*email\s*\}\}/gi, client.email ?? "");
        processedBody = processedBody.replace(/\{\{\s*property_address\s*\}\}/gi, leadAddress);
        processedBody = processedBody.replace(/\{\{\s*lockbox_code\s*\}\}/gi, lockboxValue);
        processedBody = processedBody.replace(/\{\{\s*lead\.lockbox_code\s*\}\}/gi, lockboxValue);
        processedBody = processedBody.replace(/\{\{\s*file_number\s*\}\}/gi, fileNumber);
        processedBody = processedBody.replace(/\{\{\s*side_suffix\s*\}\}/gi, sideSuffix);
        processedBody = processedBody.replace(/\{\{\s*property_role_row\s*\}\}/gi, propertyRoleRow);

        // No HTML wrapper / logo injection — the DB template owns its layout.
        const htmlBody = processedBody

        // Apply placeholder replacement to subject — derived from template only.
        let processedSubject = (template.subject || template.name)
            .replace(/&#123;/g, "{")
            .replace(/&#125;/g, "}");
        for (const [key, value] of Object.entries(placeholders)) {
            processedSubject = processedSubject.replaceAll(key, value);
        }
        processedSubject = processedSubject.replace(/\{\{\s*lead_address\s*\}\}/gi, leadAddress);
        processedSubject = processedSubject.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, deal.file_number ?? "");
        processedSubject = processedSubject.replace(/\{\{\s*user\.first_name\s*\}\}/gi, client.first_name ?? "");
        processedSubject = processedSubject.replace(/\{\{\s*user\.full_name\s*\}\}/gi, fullName);
        processedSubject = processedSubject.replace(/\{\{\s*first_name\s*\}\}/gi, client.first_name ?? "");
        processedSubject = processedSubject.replace(/\{\{\s*full_name\s*\}\}/gi, fullName);
        processedSubject = processedSubject.replace(/\{\{\s*property_address\s*\}\}/gi, leadAddress);
        processedSubject = processedSubject.replace(/\{\{\s*file_number\s*\}\}/gi, fileNumber);
        processedSubject = processedSubject.replace(/\{\{\s*side_suffix\s*\}\}/gi, sideSuffix);

        const { data: sendResult, error: sendError } = await resend.emails.send({
            from: fromEmail,
            replyTo: "testing@iclosed.ca",
            to: [client.email],
            subject: processedSubject,
            html: htmlBody,
        })

        if (sendError) {
            return { success: false, email: client.email, error: sendError.message }
        }

        console.log(
            `[Milestone Email] Sent to ${client.email}, milestone: "${milestone.title}", id: ${sendResult?.id}`
        )

        return { success: true, email: client.email }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Handles direct email send from the customer portal.
 * The portal sends: { milestone_id, deal_id, lead_id, client_id, email_template_id, milestone_title }
 * We fetch the template, client, and send the email directly.
 */
async function handlePortalRequest(body: Record<string, any>) {
    const { deal_id, client_id, milestone_title, milestone_id } = body
    let { email_template_id } = body

    if (!client_id) {
        return NextResponse.json({ success: false, error: "client_id is required" }, { status: 400 })
    }

    // If no email_template_id provided, try to get it from the milestone
    if (!email_template_id && milestone_id) {
        const { data: ms } = await supabaseAdmin
            .from("milestones")
            .select("email_template_id")
            .eq("id", milestone_id)
            .single()
        if (ms?.email_template_id) email_template_id = ms.email_template_id
    }

    // If still no template, try to find one by matching the milestone title
    if (!email_template_id && milestone_title) {
        const { data: templates } = await supabaseAdmin
            .from("email_templates")
            .select("id, name")
            .eq("is_active", true)
        if (templates) {
            const match = templates.find((t: any) =>
                t.name.toLowerCase().includes(milestone_title.toLowerCase()) ||
                milestone_title.toLowerCase().includes(t.name.toLowerCase())
            )
            if (match) email_template_id = match.id
        }
    }

    if (!email_template_id) {
        console.log(`[MilestoneEmail Portal] No email template found for milestone "${milestone_title}" — skipping`)
        return NextResponse.json({ success: true, message: "No email template linked to this milestone" })
    }

    // Get email template
    const { data: template } = await supabaseAdmin
        .from("email_templates")
        .select("*")
        .eq("id", email_template_id)
        .single()

    if (!template?.body) {
        return NextResponse.json({ success: false, error: "Email template has no content" }, { status: 400 })
    }

    // Strict is_active check — if admin disabled this template, skip the send
    if (!template.is_active) {
        console.log(
            `[MilestoneEmail Portal] Skipped — template "${template.name}" (id=${template.id}) is inactive. milestone="${milestone_title}"`,
        )
        return NextResponse.json({
            success: true,
            skipped: true,
            message: `Template "${template.name}" is inactive — milestone email skipped`,
        })
    }

    if (!process.env.RESEND_API_KEY) {
        return NextResponse.json({ success: false, error: "Email service not configured" }, { status: 500 })
    }

    const resend = new Resend(process.env.RESEND_API_KEY)
    const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>"

    // Find all deals in the family (purchaser + co-purchasers)
    let allDealIds: string[] = deal_id ? [deal_id] : []
    if (deal_id) {
        allDealIds = await getFamilyDealIds(deal_id)
    }

    // Send email to each deal's client
    const results: { email?: string; success: boolean; error?: string }[] = []

    for (const did of allDealIds) {
        const result = await sendEmailForDeal(did, { title: milestone_title }, template, resend, fromEmail)
        results.push(result)

        // Mark milestone email_sent on each linked deal's matching milestone
        if (milestone_id) {
            try {
                // Get stage_template_id from the original milestone
                const { data: origMilestone } = await supabaseAdmin
                    .from("milestones")
                    .select("stage_template_id")
                    .eq("id", milestone_id)
                    .single()

                if (origMilestone?.stage_template_id) {
                    await supabaseAdmin
                        .from("milestones")
                        .update({ email_sent: true })
                        .eq("deal_id", did)
                        .eq("stage_template_id", origMilestone.stage_template_id)
                }
            } catch {
                // Non-blocking
            }
        }
    }

    // Also mark email_sent on the original milestone
    if (milestone_id) {
        await supabaseAdmin
            .from("milestones")
            .update({ email_sent: true })
            .eq("id", milestone_id)
    }

    const successCount = results.filter((r) => r.success).length
    const failedCount = results.filter((r) => !r.success).length

    console.log(`[MilestoneEmail Portal] Sent to ${successCount} client(s), milestone: "${milestone_title}"`)

    return NextResponse.json({
        success: true,
        emails_sent: successCount,
        emails_failed: failedCount,
        email_sent_to: results.filter((r) => r.success).map((r) => r.email),
    })
}

export async function POST(req: Request) {
    try {
        const body = await req.json()

        // Detect customer portal format (snake_case fields with client_id)
        if (body.client_id) {
            return handlePortalRequest(body)
        }

        // Admin panel format (camelCase fields)
        const milestoneId = body.milestoneId ?? body.milestone_id
        const dealId = body.dealId ?? body.deal_id
        const sendToLinkedDeals = body.sendToLinkedDeals ?? false

        if (!milestoneId) {
            return NextResponse.json({ success: false, error: "milestoneId is required" }, { status: 400 })
        }

        // 1. Get milestone
        const { data: milestone } = await supabaseAdmin
            .from("milestones")
            .select("*")
            .eq("id", milestoneId)
            .single()

        if (!milestone) throw new Error("Milestone not found")

        // 2. Update milestone status to Completed
        await supabaseAdmin
            .from("milestones")
            .update({
                status: "Completed",
                completed_at: new Date(),
            })
            .eq("id", milestoneId)

        await supabaseAdmin
            .from("tasks")
            .update({
                status: "Completed",
                completed: true,
                completed_at: new Date().toISOString(),
            })
            .eq("milestone_id", milestoneId)

        // 3. If no email template linked, just mark completed
        if (!milestone.email_template_id) {
            return NextResponse.json({ success: true, message: "Status updated, no email template linked" })
        }

        // Prevent duplicate emails
        if (milestone.email_sent) {
            return NextResponse.json({ success: true, alreadySent: true, message: "Email already sent" })
        }

        // 4. Get email template
        const { data: template } = await supabaseAdmin
            .from("email_templates")
            .select("*")
            .eq("id", milestone.email_template_id)
            .single()

        if (!template?.body) {
            return NextResponse.json({ success: false, error: "Email template has no content" }, { status: 400 })
        }

        // Strict is_active check — admin can disable a milestone email by
        // marking its linked template inactive. Skip the send (milestone
        // status was already updated above; we just don't send the email).
        if (!template.is_active) {
            console.log(
                `[MilestoneEmail] Skipped — template "${template.name}" (id=${template.id}) is inactive. milestone=${milestoneId}`,
            )
            return NextResponse.json({
                success: true,
                skipped: true,
                message: `Template "${template.name}" is inactive — milestone email skipped`,
            })
        }

        // 5. Set up Resend
        if (!process.env.RESEND_API_KEY) {
            return NextResponse.json(
                { success: false, error: "Email service not configured (missing RESEND_API_KEY)" },
                { status: 500 }
            )
        }

        const resend = new Resend(process.env.RESEND_API_KEY)
        const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>"

        // 6. Send email to primary deal's client
        const primaryResult = await sendEmailForDeal(dealId, milestone, template, resend, fromEmail)

        if (!primaryResult.success) {
            return NextResponse.json(
                { success: false, error: `Email send failed: ${primaryResult.error}` },
                { status: 500 }
            )
        }

        // 7. If sendToLinkedDeals, also send to all co-purchaser/primary linked deals
        const linkedResults: { email?: string; success: boolean; error?: string }[] = []

        if (sendToLinkedDeals) {
            const familyDealIds = await getFamilyDealIds(dealId)
            const otherDealIds = familyDealIds.filter((id) => id !== dealId)

            for (const linkedDealId of otherDealIds) {
                // Also complete the matching milestone on the linked deal
                try {
                    const { data: linkedMilestones } = await supabaseAdmin
                        .from("milestones")
                        .select("id, email_sent, stage_template_id")
                        .eq("deal_id", linkedDealId)
                        .eq("stage_template_id", milestone.stage_template_id)
                        .maybeSingle()

                    if (linkedMilestones && !linkedMilestones.email_sent) {
                        await supabaseAdmin
                            .from("milestones")
                            .update({ status: "Completed", completed_at: new Date(), email_sent: true })
                            .eq("id", linkedMilestones.id)

                        await supabaseAdmin
                            .from("tasks")
                            .update({
                                status: "Completed",
                                completed: true,
                                completed_at: new Date().toISOString(),
                            })
                            .eq("milestone_id", linkedMilestones.id)
                    }
                } catch {
                    // Non-blocking
                }

                const result = await sendEmailForDeal(linkedDealId, milestone, template, resend, fromEmail)
                linkedResults.push(result)
            }
        }

        // 8. Mark email_sent on ALL family milestones with same stage_template_id
        await supabaseAdmin
            .from("milestones")
            .update({ email_sent: true })
            .eq("id", milestoneId)

        // Also mark email_sent on all linked deal milestones by stage_template_id
        if (milestone.stage_template_id && dealId) {
            try {
                const allFamilyDealIds = await getFamilyDealIds(dealId)
                await supabaseAdmin
                    .from("milestones")
                    .update({ email_sent: true })
                    .eq("stage_template_id", milestone.stage_template_id)
                    .in("deal_id", allFamilyDealIds)
            } catch {
                // Non-blocking
            }
        }

        const totalSent = 1 + linkedResults.filter((r) => r.success).length
        const totalFailed = linkedResults.filter((r) => !r.success).length

        return NextResponse.json({
            success: true,
            email_sent_to: primaryResult.email,
            linked_emails_sent: totalSent - 1,
            linked_emails_failed: totalFailed,
        })

    } catch (error: any) {
        console.error("POST /api/admin/send-milestone-email error:", error)
        return NextResponse.json(
            { success: false, error: error.message },
            { status: 500 }
        )
    }
}
