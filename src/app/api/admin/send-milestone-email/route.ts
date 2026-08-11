import { NextResponse } from "next/server"
import supabaseAdmin from "@/lib/supabaseAdmin"
import { Resend } from "resend"
import { getFamilyDealIds } from "@/lib/familyDeals"
import { formatLeadTypeLabel, buildLeadAddressForEmail } from "@/lib/leadEmailAddress"
import { guardServiceRequest } from "@/lib/verifyServiceSignature"
import { emailFrom, emailReplyTo, normalizeRecipientEmail } from "@/lib/emailIdentity"
import { buildAgentCcList } from "@/lib/agentCc"

/** A milestone email rendered for one deal, not yet sent. */
type RenderedDealEmail = {
    dealId: string
    email: string
    firstName: string
    lastName: string
    fullName: string
    subject: string
    html: string
    cc: string[]
}

type DealSendResult = { success: boolean; email?: string; error?: string }

/**
 * Placeholders that name the recipient resolve to these sentinels while a deal
 * is being rendered, not to the client's own name.
 *
 * Everyone on a file used to get their own copy of the milestone email — a
 * two-purchaser family saw two identical "Title Search Completed" messages land
 * separately, each blind to the other. They are now merged into a single send
 * (see sendGroupedEmails), which means the greeting has to name every recipient
 * on the To line instead of whichever deal happened to render first. Rendering
 * against sentinels lets us compare two deals' bodies for equality first and
 * substitute the joined names afterwards, so genuinely different content (a
 * co-seller's sale-side address and role vs a co-purchaser's) still splits into
 * separate emails rather than leaking one side's details to the other.
 *
 * NUL-delimited so they can never collide with template text.
 */
const NAME_TOKEN = {
    first: "\u0000ICL_FIRST\u0000",
    last: "\u0000ICL_LAST\u0000",
    full: "\u0000ICL_FULL\u0000",
    email: "\u0000ICL_EMAIL\u0000",
} as const

/** "Alice", "Alice and Bob", "Alice, Bob and Carol" — dupes dropped. */
function joinNames(values: string[]): string {
    const seen = new Set<string>()
    const uniq: string[] = []
    for (const raw of values) {
        const v = (raw ?? "").trim()
        if (!v) continue
        const key = v.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        uniq.push(v)
    }
    if (uniq.length === 0) return ""
    if (uniq.length === 1) return uniq[0]
    if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`
    return `${uniq.slice(0, -1).join(", ")} and ${uniq[uniq.length - 1]}`
}

/**
 * Renders the milestone email for one deal's client without sending it.
 * Returns { ok: false } with a reason when the deal has no reachable client.
 */
async function buildEmailForDeal(
    dealId: string,
    milestone: any,
    template: any,
): Promise<{ ok: true; value: RenderedDealEmail } | { ok: false; email?: string; error: string }> {
    try {
        const { data: deal } = await supabaseAdmin
            .from("deals")
            .select("client_id, lead_id, file_number, property_address, lockbox_code, type, closing_date, partner_id")
            .eq("id", dealId)
            .single()

        if (!deal?.client_id) return { ok: false, error: "Deal or client not found" }

        const { data: client } = await supabaseAdmin
            .from("clients")
            .select("email, first_name, last_name")
            .eq("id", deal.client_id)
            .single()

        if (!client?.email) return { ok: false, error: "Client email not found" }

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
            // User placeholders — sentinels, resolved once the recipients that
            // share this rendering are known (see NAME_TOKEN).
            "{{ user.first_name }}": NAME_TOKEN.first,
            "{{ user.last_name }}": NAME_TOKEN.last,
            "{{ user.full_name }}": NAME_TOKEN.full,
            "{{ user.get_full_name }}": NAME_TOKEN.full,
            "{{ user.email }}": NAME_TOKEN.email,
            "{{user.first_name}}": NAME_TOKEN.first,
            "{{user.last_name}}": NAME_TOKEN.last,
            "{{user.full_name}}": NAME_TOKEN.full,
            "{{user.get_full_name}}": NAME_TOKEN.full,
            "{{user.email}}": NAME_TOKEN.email,
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
            "{{ first_name }}": NAME_TOKEN.first,
            "{{ last_name }}": NAME_TOKEN.last,
            "{{ full_name }}": NAME_TOKEN.full,
            "{{ email }}": NAME_TOKEN.email,
            "{{ property_address }}": leadAddress,
            "{{ lockbox_code }}": lockboxValue,
            "{{lockbox_code}}": lockboxValue,
            "{{ lead.lockbox_code }}": lockboxValue,
            "{{lead.lockbox_code}}": lockboxValue,
            "{{ file_number }}": fileNumber,
            "{{ side_suffix }}": sideSuffix,
            "{{ property_role_row }}": propertyRoleRow,
            "{{first_name}}": NAME_TOKEN.first,
            "{{last_name}}": NAME_TOKEN.last,
            "{{full_name}}": NAME_TOKEN.full,
            "{{email}}": NAME_TOKEN.email,
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
        processedBody = processedBody.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, NAME_TOKEN.full);
        processedBody = processedBody.replace(/\{\{\s*user\.first_name\s*\}\}/gi, NAME_TOKEN.first);
        processedBody = processedBody.replace(/\{\{\s*user\.last_name\s*\}\}/gi, NAME_TOKEN.last);
        processedBody = processedBody.replace(/\{\{\s*user\.full_name\s*\}\}/gi, NAME_TOKEN.full);
        processedBody = processedBody.replace(/\{\{\s*user\.email\s*\}\}/gi, NAME_TOKEN.email);
        processedBody = processedBody.replace(/\{\{\s*lead_address\s*\}\}/gi, leadAddress);
        processedBody = processedBody.replace(/\{\{\s*lead\.address_line1\s*\}\}/gi, lead?.address_street ?? deal.property_address ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.address_city\s*\}\}/gi, lead?.address_city ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.address_province\s*\}\}/gi, lead?.address_province ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, deal.file_number ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead_type\s*\}\}/gi, displayLeadType);
        processedBody = processedBody.replace(/\{\{\s*stage_name\s*\}\}/gi, milestone?.title ?? "");
        processedBody = processedBody.replace(/\{\{\s*stage_status\s*\}\}/gi, milestone?.status ?? "Completed");
        // Short-form alias fallbacks
        processedBody = processedBody.replace(/\{\{\s*first_name\s*\}\}/gi, NAME_TOKEN.first);
        processedBody = processedBody.replace(/\{\{\s*last_name\s*\}\}/gi, NAME_TOKEN.last);
        processedBody = processedBody.replace(/\{\{\s*full_name\s*\}\}/gi, NAME_TOKEN.full);
        processedBody = processedBody.replace(/\{\{\s*email\s*\}\}/gi, NAME_TOKEN.email);
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
        processedSubject = processedSubject.replace(/\{\{\s*user\.first_name\s*\}\}/gi, NAME_TOKEN.first);
        processedSubject = processedSubject.replace(/\{\{\s*user\.full_name\s*\}\}/gi, NAME_TOKEN.full);
        processedSubject = processedSubject.replace(/\{\{\s*first_name\s*\}\}/gi, NAME_TOKEN.first);
        processedSubject = processedSubject.replace(/\{\{\s*full_name\s*\}\}/gi, NAME_TOKEN.full);
        processedSubject = processedSubject.replace(/\{\{\s*property_address\s*\}\}/gi, leadAddress);
        processedSubject = processedSubject.replace(/\{\{\s*file_number\s*\}\}/gi, fileNumber);
        processedSubject = processedSubject.replace(/\{\{\s*side_suffix\s*\}\}/gi, sideSuffix);

        // "Shared with agent?" templates also CC everyone attached to the file:
        // the partner's primary agent, any additional partner_contacts, and the
        // deal's own cc_emails. Client stays the primary recipient; CC is
        // skipped entirely when the flag is off.
        let cc: string[] = []
        if (template.shared_with_agent) {
            cc = await buildAgentCcList({
                partnerId: deal.partner_id,
                dealId,
                exclude: [client.email],
            })
        }

        return {
            ok: true,
            value: {
                dealId,
                email: normalizeRecipientEmail(client.email),
                firstName: client.first_name ?? "",
                lastName: client.last_name ?? "",
                fullName,
                subject: processedSubject,
                html: htmlBody,
                cc,
            },
        }
    } catch (err: any) {
        return { ok: false, error: err.message }
    }
}

/**
 * Sends the rendered deal emails, merging every deal whose subject and body came
 * out identical into ONE send with all of those clients on the To line.
 *
 * Two family members on the same side of a file receive the same words, so they
 * belong on the same thread — they can see each other's replies and we stop
 * sending near-duplicate mail. Anything that genuinely renders differently (a
 * co-seller's sale-side address, role and "Sale" label vs a co-purchaser's)
 * falls into its own group and is still sent separately, so neither side sees
 * the other's details.
 *
 * CC is the union of the group's per-deal CC lists minus everyone already on
 * To — a partner contact attached to only one deal in the family still gets
 * copied on the merged email exactly once.
 *
 * Returns one result per deal, so callers keep their per-deal success counts.
 */
async function sendGroupedEmails(
    rendered: RenderedDealEmail[],
    milestoneTitle: string,
    sharedWithAgent: boolean,
    resend: Resend,
    fromEmail: string,
): Promise<Map<string, DealSendResult>> {
    const results = new Map<string, DealSendResult>()

    // Insertion-ordered so the caller's primary deal stays in the first group.
    const groups = new Map<string, RenderedDealEmail[]>()
    for (const r of rendered) {
        // Length-prefixed so a subject/body boundary can never shift and make
        // two different renderings collide on the same key.
        const key = `${r.subject.length}:${r.subject}${r.html}`
        const bucket = groups.get(key)
        if (bucket) bucket.push(r)
        else groups.set(key, [r])
    }

    for (const group of groups.values()) {
        const to: string[] = []
        const toSeen = new Set<string>()
        for (const r of group) {
            const key = r.email.toLowerCase()
            if (!key || toSeen.has(key)) continue
            toSeen.add(key)
            to.push(r.email)
        }

        const cc: string[] = []
        const ccSeen = new Set<string>()
        for (const r of group) {
            for (const addr of r.cc) {
                const key = addr.toLowerCase()
                if (!key || toSeen.has(key) || ccSeen.has(key)) continue
                ccSeen.add(key)
                cc.push(addr)
            }
        }

        // Resolve the name sentinels now that the full recipient set is known:
        // "Dear Alice and Bob," on a merged email, "Dear Alice," on a solo one.
        const firstNames = joinNames(group.map((r) => r.firstName))
        const lastNames = joinNames(group.map((r) => r.lastName))
        const fullNames = joinNames(group.map((r) => r.fullName))
        const emails = joinNames(group.map((r) => r.email))
        const resolve = (text: string) =>
            text
                .replaceAll(NAME_TOKEN.first, firstNames)
                .replaceAll(NAME_TOKEN.last, lastNames)
                .replaceAll(NAME_TOKEN.full, fullNames)
                .replaceAll(NAME_TOKEN.email, emails)

        try {
            const { data: sendResult, error: sendError } = await resend.emails.send({
                from: fromEmail,
                replyTo: emailReplyTo(),
                to,
                ...(cc.length > 0 ? { cc } : {}),
                subject: resolve(group[0].subject),
                html: resolve(group[0].html),
            })

            if (sendError) {
                for (const r of group) {
                    results.set(r.dealId, { success: false, email: r.email, error: sendError.message })
                }
                continue
            }

            console.log(
                `[Milestone Email] Sent to ${to.join(", ")}` +
                `${cc.length > 0 ? ` (cc ${cc.length}: ${cc.join(", ")})` : sharedWithAgent ? " (shared_with_agent on, but no cc addresses on file — no cc)" : ""}` +
                `, milestone: "${milestoneTitle}", id: ${sendResult?.id}`
            )

            for (const r of group) {
                results.set(r.dealId, { success: true, email: r.email })
            }
        } catch (err: any) {
            for (const r of group) {
                results.set(r.dealId, { success: false, email: r.email, error: err?.message ?? "Send failed" })
            }
        }
    }

    return results
}

/**
 * Renders every given deal and sends the result, merged by identical content.
 * Deals that can't be rendered (no client / no email) are reported as failures
 * without blocking the rest of the family's send.
 */
async function sendMilestoneEmails(
    dealIds: string[],
    milestone: any,
    template: any,
    resend: Resend,
    fromEmail: string,
): Promise<Map<string, DealSendResult>> {
    const results = new Map<string, DealSendResult>()
    const rendered: RenderedDealEmail[] = []

    for (const dealId of dealIds) {
        const built = await buildEmailForDeal(dealId, milestone, template)
        if (built.ok) rendered.push(built.value)
        else results.set(dealId, { success: false, email: built.email, error: built.error })
    }

    const sent = await sendGroupedEmails(
        rendered,
        milestone?.title ?? "",
        !!template.shared_with_agent,
        resend,
        fromEmail,
    )
    for (const [dealId, result] of sent) results.set(dealId, result)

    return results
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
    const fromEmail = emailFrom();

    // Find all deals in the family (purchaser + co-purchasers)
    let allDealIds: string[] = deal_id ? [deal_id] : []
    if (deal_id) {
        allDealIds = await getFamilyDealIds(deal_id)
    }

    // One send per distinct rendering — the whole family lands on a single
    // email's To line whenever they'd have received the same words anyway.
    const sendResults = await sendMilestoneEmails(
        allDealIds,
        { title: milestone_title },
        template,
        resend,
        fromEmail,
    )
    const results: DealSendResult[] = allDealIds.map(
        (did) => sendResults.get(did) ?? { success: false, error: "Deal was not processed" },
    )

    for (const did of allDealIds) {
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
        const fromEmail = emailFrom();

        // 6. Send. The primary and any linked deals go out together so family
        //    members who'd receive identical text share one email rather than
        //    getting a copy each; only genuinely different renderings split.
        const otherDealIds: string[] = []
        if (sendToLinkedDeals) {
            const familyDealIds = await getFamilyDealIds(dealId)
            otherDealIds.push(...familyDealIds.filter((id) => id !== dealId))
        }

        const sendResults = await sendMilestoneEmails(
            [dealId, ...otherDealIds],
            milestone,
            template,
            resend,
            fromEmail,
        )

        const primaryResult = sendResults.get(dealId) ?? {
            success: false,
            error: "Primary deal was not processed",
        }

        if (!primaryResult.success) {
            return NextResponse.json(
                { success: false, error: `Email send failed: ${primaryResult.error}` },
                { status: 500 }
            )
        }

        const linkedResults: DealSendResult[] = otherDealIds.map(
            (id) => sendResults.get(id) ?? { success: false, error: "Deal was not processed" },
        )

        // 7. Complete the matching milestone on every linked deal that was
        //    emailed. Kept after the send, as before, so a failed send doesn't
        //    leave the family's milestones marked as notified.
        if (sendToLinkedDeals) {
            for (const linkedDealId of otherDealIds) {
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
