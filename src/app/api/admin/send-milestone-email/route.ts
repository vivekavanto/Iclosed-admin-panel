import { NextResponse } from "next/server"
import supabaseAdmin from "@/lib/supabaseAdmin"
import { Resend } from "resend"

/**
 * Finds all deal IDs in the same co-purchaser family as the given deal.
 * Returns an array including the original dealId.
 */
async function getFamilyDealIds(dealId: string): Promise<string[]> {
    try {
        const { data: deal } = await supabaseAdmin
            .from("deals")
            .select("lead_id")
            .eq("id", dealId)
            .single()

        if (!deal?.lead_id) return [dealId]

        const { data: lead } = await supabaseAdmin
            .from("leads")
            .select("id, parent_lead_id")
            .eq("id", deal.lead_id)
            .single()

        if (!lead) return [dealId]

        const rootLeadId = lead.parent_lead_id ?? lead.id

        const { data: familyLeads } = await supabaseAdmin
            .from("leads")
            .select("id")
            .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)

        if (!familyLeads || familyLeads.length <= 1) return [dealId]

        const familyLeadIds = familyLeads.map((l) => l.id)

        const { data: familyDeals } = await supabaseAdmin
            .from("deals")
            .select("id")
            .in("lead_id", familyLeadIds)

        if (!familyDeals) return [dealId]

        return familyDeals.map((d) => d.id)
    } catch {
        return [dealId]
    }
}

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
            .select("client_id")
            .eq("id", dealId)
            .single()

        if (!deal?.client_id) return { success: false, error: "Deal or client not found" }

        const { data: client } = await supabaseAdmin
            .from("clients")
            .select("email, first_name, last_name")
            .eq("id", deal.client_id)
            .single()

        if (!client?.email) return { success: false, error: "Client email not found" }

        // Replace placeholders in email body
        const fullName = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim()
        const placeholders: Record<string, string> = {
            "{{ user.first_name }}": client.first_name ?? "",
            "{{ user.last_name }}": client.last_name ?? "",
            "{{ user.full_name }}": fullName,
            "{{ user.email }}": client.email,
            "{{user.first_name}}": client.first_name ?? "",
            "{{user.last_name}}": client.last_name ?? "",
            "{{user.full_name}}": fullName,
            "{{user.email}}": client.email,
        }

        let processedBody = template.body
        for (const [key, value] of Object.entries(placeholders)) {
            processedBody = processedBody.replaceAll(key, value)
        }

        const htmlBody = `
      <div>
        ${processedBody}
        <img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />
      </div>
    `

        const { data: sendResult, error: sendError } = await resend.emails.send({
            from: fromEmail,
            to: [client.email],
            subject: template.name || "Milestone Completed",
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

export async function POST(req: Request) {
    try {
        const { milestoneId, dealId, sendToLinkedDeals } = await req.json()

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

        // 5. Set up Resend
        if (!process.env.RESEND_API_KEY) {
            return NextResponse.json(
                { success: false, error: "Email service not configured (missing RESEND_API_KEY)" },
                { status: 500 }
            )
        }

        const resend = new Resend(process.env.RESEND_API_KEY)
        const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <onboarding@resend.dev>"

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
                    }
                } catch {
                    // Non-blocking
                }

                const result = await sendEmailForDeal(linkedDealId, milestone, template, resend, fromEmail)
                linkedResults.push(result)
            }
        }

        // 8. Mark email_sent on primary milestone
        await supabaseAdmin
            .from("milestones")
            .update({ email_sent: true })
            .eq("id", milestoneId)

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
