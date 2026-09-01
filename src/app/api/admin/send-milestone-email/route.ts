import { NextResponse } from "next/server"
import supabaseAdmin from "@/lib/supabaseAdmin"
import { Resend } from "resend"
import { getFamilyDealIds } from "@/lib/familyDeals"
import { guardServiceRequest } from "@/lib/verifyServiceSignature"
import { getDealFirmKey } from "@/lib/leadFirm"
import { maybeNotifyAllTasksComplete } from "@/lib/notifyAllTasksComplete"
import { resolveMilestoneSide } from "@/lib/milestoneSide"
import {
    collectMilestoneRecipients,
    sendCombinedMilestoneEmail,
} from "@/lib/sendMilestoneEmail"

/**
 * A file's clients get ONE milestone email between them — every eligible party
 * in `to`, the referral agent CC'd once. Recipient selection, side scoping and
 * rendering all live in sendMilestoneEmail.ts; this route owns the milestone /
 * task completion bookkeeping around it.
 */

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
    const firm = await getDealFirmKey(deal_id ?? null)

    // Find all deals in the family (purchaser + co-purchasers)
    let allDealIds: string[] = deal_id ? [deal_id] : []
    if (deal_id) {
        allDealIds = await getFamilyDealIds(deal_id)
    }

    // On a Purchase & Sale file every family deal carries BOTH sides' milestones,
    // so a purchase-side stage would otherwise reach the co-sellers as well.
    // Scope the RECIPIENT LIST to the side this milestone belongs to — the send
    // itself is a single email to whoever survives. See milestoneSide.ts.
    let milestoneSide = null as Awaited<ReturnType<typeof resolveMilestoneSide>>
    if (milestone_id) {
        const { data: ms } = await supabaseAdmin
            .from("milestones")
            .select("side, stage_template_id")
            .eq("id", milestone_id)
            .maybeSingle()
        if (ms) milestoneSide = await resolveMilestoneSide(ms)
    }

    const { recipients, skippedDealIds } = await collectMilestoneRecipients(allDealIds, milestoneSide)

    if (skippedDealIds.length) {
        console.log(
            `[MilestoneEmail Portal] ${skippedDealIds.length} deal(s) not emailed for ${milestoneSide ?? "side-less"} milestone "${milestone_title}": ${skippedDealIds.join(", ")}`,
        )
    }

    const sendResult = await sendCombinedMilestoneEmail({
        recipients,
        milestone: { title: milestone_title },
        template,
        resend,
        firm,
        milestoneSide,
    })

    // Mark milestone email_sent on every linked deal's matching milestone. This
    // runs over the WHOLE family, not just the deals we emailed: the wrong-side
    // client is intentionally not being emailed, so their milestone should still
    // be marked done rather than left looking un-sent and retried forever.
    if (milestone_id) {
        try {
            const { data: origMilestone } = await supabaseAdmin
                .from("milestones")
                .select("stage_template_id")
                .eq("id", milestone_id)
                .single()

            if (origMilestone?.stage_template_id && allDealIds.length) {
                await supabaseAdmin
                    .from("milestones")
                    .update({ email_sent: true })
                    .eq("stage_template_id", origMilestone.stage_template_id)
                    .in("deal_id", allDealIds)
            }
        } catch {
            // Non-blocking
        }

        await supabaseAdmin
            .from("milestones")
            .update({ email_sent: true })
            .eq("id", milestone_id)
    }

    console.log(
        `[MilestoneEmail Portal] Sent 1 email to ${sendResult.recipients.length} client(s), milestone: "${milestone_title}"`,
    )

    return NextResponse.json({
        success: true,
        // Clients reached — one email now carries all of them.
        emails_sent: sendResult.success ? sendResult.recipients.length : 0,
        emails_failed: sendResult.success ? 0 : 1,
        email_sent_to: sendResult.recipients,
        cc: sendResult.cc,
        ...(sendResult.error ? { error: sendResult.error } : {}),
    })
}

export async function POST(req: Request) {
    try {
        const raw = await req.text()
        const body = JSON.parse(raw)

        // Detect customer portal format (snake_case fields with client_id).
        // Only the portal path is signature-gated: it reaches this handler
        // cookie-less (route is whitelisted in middleware). The admin-panel path
        // below arrives with an authenticated admin cookie from the browser UI,
        // so it is not signed. See SEC-002 scope note about splitting this route.
        if (body.client_id) {
            const blocked = guardServiceRequest(req, raw, { routeKey: "send-milestone-email" })
            if (blocked) return blocked
            return handlePortalRequest(body)
        }

        // Admin panel format (camelCase fields)
        const milestoneId = body.milestoneId ?? body.milestone_id
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

        // The caller normally passes the deal it clicked from; fall back to the
        // milestone's own deal so family enumeration can never run on undefined.
        const dealId: string | null = body.dealId ?? body.deal_id ?? milestone.deal_id ?? null

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
        const firm = await getDealFirmKey(dealId ?? null)

        // On a Purchase & Sale file every family deal carries BOTH sides'
        // milestones, so a purchase-side stage ("Title Search", "Financing Firm ->
        // Mortgage Instructions") must not reach the co-sellers. The completion
        // mirror below is already side-safe because it matches on
        // stage_template_id; the recipient list is scoped separately. See
        // milestoneSide.ts — an unknown side on either end still sends.
        const milestoneSide = await resolveMilestoneSide(milestone)

        // The whole family is always marked as emailed (step 8, unchanged), but
        // only a sendToLinkedDeals request actually reaches beyond this deal.
        const allFamilyDealIds = dealId ? await getFamilyDealIds(dealId) : []
        const familyDealIds = sendToLinkedDeals
            ? allFamilyDealIds
            : dealId
                ? [dealId]
                : []

        // 6. Mirror completion onto the rest of the family. Independent of who
        // gets emailed — it is keyed on stage_template_id, so it is already
        // side-correct.
        if (sendToLinkedDeals) {
            for (const linkedDealId of familyDealIds.filter((id) => id !== dealId)) {
                try {
                    const { data: linkedMilestone } = await supabaseAdmin
                        .from("milestones")
                        .select("id, email_sent, stage_template_id")
                        .eq("deal_id", linkedDealId)
                        .eq("stage_template_id", milestone.stage_template_id)
                        .maybeSingle()

                    if (linkedMilestone && !linkedMilestone.email_sent) {
                        await supabaseAdmin
                            .from("milestones")
                            .update({ status: "Completed", completed_at: new Date(), email_sent: true })
                            .eq("id", linkedMilestone.id)

                        await supabaseAdmin
                            .from("tasks")
                            .update({
                                status: "Completed",
                                completed: true,
                                completed_at: new Date().toISOString(),
                            })
                            .eq("milestone_id", linkedMilestone.id)
                    }
                } catch {
                    // Non-blocking
                }
            }
        }

        // 7. One email to the whole eligible family, agent CC'd once.
        const { recipients, skippedDealIds } = await collectMilestoneRecipients(
            familyDealIds,
            milestoneSide,
        )

        if (skippedDealIds.length) {
            console.log(
                `[MilestoneEmail] ${skippedDealIds.length} deal(s) not emailed for ${milestoneSide ?? "side-less"} milestone "${milestone.title}": ${skippedDealIds.join(", ")}`,
            )
        }

        const sendResult = await sendCombinedMilestoneEmail({
            recipients,
            milestone,
            template,
            resend,
            firm,
            milestoneSide,
        })

        if (!sendResult.success) {
            return NextResponse.json(
                { success: false, error: `Email send failed: ${sendResult.error}` },
                { status: 500 }
            )
        }

        // 8. Mark email_sent on ALL family milestones with same stage_template_id
        await supabaseAdmin
            .from("milestones")
            .update({ email_sent: true })
            .eq("id", milestoneId)

        if (milestone.stage_template_id && allFamilyDealIds.length) {
            try {
                await supabaseAdmin
                    .from("milestones")
                    .update({ email_sent: true })
                    .eq("stage_template_id", milestone.stage_template_id)
                    .in("deal_id", allFamilyDealIds)
            } catch {
                // Non-blocking
            }
        }

        // This route bulk-completes every task under the milestone (steps 2 and
        // 6) without going through recalcMilestonesForFamily, so it's the one
        // completion path the alert hook in recalcMilestones can't see. Fire it
        // here too — the helper's claim makes a double call a no-op.
        if (dealId) {
            try {
                await maybeNotifyAllTasksComplete(dealId)
            } catch (err) {
                console.warn("[MilestoneEmail] all-tasks-complete alert failed:", err)
            }
        }

        return NextResponse.json({
            success: true,
            // Every client on the file who was in scope for this milestone.
            // Empty when they were all on the other side and deliberately skipped.
            email_sent_to: sendResult.recipients,
            recipient_count: sendResult.recipients.length,
            cc: sendResult.cc,
            ...(milestoneSide ? { milestone_side: milestoneSide } : {}),
        })

    } catch (error: any) {
        console.error("POST /api/admin/send-milestone-email error:", error)
        return NextResponse.json(
            { success: false, error: error.message },
            { status: 500 }
        )
    }
}
