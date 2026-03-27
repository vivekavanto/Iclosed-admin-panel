import { NextResponse } from "next/server"
import supabaseAdmin from "@/lib/supabaseAdmin"
import { Resend } from "resend"

export async function POST(req: Request) {
    try {
        const { milestoneId, dealId } = await req.json()

        // 1️⃣ Get milestone
        const { data: milestone } = await supabaseAdmin
            .from("milestones")
            .select("*")
            .eq("id", milestoneId)
            .single()

        if (!milestone) throw new Error("Milestone not found")

        // 2️⃣ Always update milestone status to Completed
        await supabaseAdmin
            .from("milestones")
            .update({
                status: "Completed",
                completed_at: new Date(),
            })
            .eq("id", milestoneId)

        // 3️⃣ If no email template linked, just mark completed (no email)
        if (!milestone.email_template_id) {
            return NextResponse.json({ success: true, message: "Status updated, no email template linked" })
        }

        // ❌ prevent duplicate emails (but status is already updated above)
        if (milestone.email_sent) {
            return NextResponse.json({ success: true, alreadySent: true, message: "Email already sent" })
        }

        // 4️⃣ Get email template
        const { data: template } = await supabaseAdmin
            .from("email_templates")
            .select("*")
            .eq("id", milestone.email_template_id)
            .single()

        if (!template?.body) {
            return NextResponse.json({ success: false, error: "Email template has no content" }, { status: 400 })
        }

        const emailBody = template.body
        const emailSubject = template.name || "Milestone Completed"

        // 5️⃣ Get deal + client email
        const { data: deal } = await supabaseAdmin
            .from("deals")
            .select("*")
            .eq("id", dealId)
            .single()

        if (!deal?.client_id) throw new Error("Deal or client not found")

        const { data: client } = await supabaseAdmin
            .from("clients")
            .select("email, first_name, last_name")
            .eq("id", deal.client_id)
            .single()

        const email = client?.email
        if (!email) throw new Error("Client email not found")

        // 5.5️⃣ Replace placeholders in email body
        const fullName = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim()
        const placeholders: Record<string, string> = {
            "{{ user.first_name }}": client.first_name ?? "",
            "{{ user.last_name }}": client.last_name ?? "",
            "{{ user.full_name }}": fullName,
            "{{ user.email }}": email,
            // Also handle without spaces
            "{{user.first_name}}": client.first_name ?? "",
            "{{user.last_name}}": client.last_name ?? "",
            "{{user.full_name}}": fullName,
            "{{user.email}}": email,
        }

        let processedBody = emailBody
        for (const [key, value] of Object.entries(placeholders)) {
            processedBody = processedBody.replaceAll(key, value)
        }

        // 6️⃣ Send Email via Resend
        if (!process.env.RESEND_API_KEY) {
            console.error("[Milestone Email] RESEND_API_KEY is not set")
            return NextResponse.json(
                { success: false, error: "Email service not configured (missing RESEND_API_KEY)" },
                { status: 500 }
            )
        }

        const resend = new Resend(process.env.RESEND_API_KEY)
        const fromEmail =
            process.env.RESEND_FROM_EMAIL || "iClosed <onboarding@resend.dev>"

        const htmlBody = `
      <div>
        ${processedBody}
        <img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />
      </div>
    `

        const { data: sendResult, error: sendError } = await resend.emails.send({
            from: fromEmail,
            to: [email],
            subject: emailSubject,
            html: htmlBody,
        })

        if (sendError) {
            console.error("[Milestone Email] Resend error:", sendError)
            return NextResponse.json(
                { success: false, error: `Email send failed: ${sendError.message}` },
                { status: 500 }
            )
        }

        // 7️⃣ Mark email_sent = true (only after successful send)
        await supabaseAdmin
            .from("milestones")
            .update({ email_sent: true })
            .eq("id", milestoneId)

        console.log(
            `[Milestone Email] Sent to ${email}, milestone: "${milestone.title}", id: ${sendResult?.id}`
        )

        return NextResponse.json({ success: true, email_id: sendResult?.id })

    } catch (error: any) {
        console.error("POST /api/admin/send-milestone-email error:", error)
        return NextResponse.json(
            { success: false, error: error.message },
            { status: 500 }
        )
    }
}
