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

        // ❌ prevent duplicate emails
        if (milestone.email_sent) {
            return NextResponse.json({ success: true, message: "Already sent" })
        }

        // 2️⃣ Update milestone status
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
            .select("email")
            .eq("id", deal.client_id)
            .single()

        const email = client?.email
        if (!email) throw new Error("Client email not found")

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
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#1e293b;line-height:1.8;font-size:14px;">
        ${emailBody.split("\n").map((line: string) => line.trim() === "" ? "<br/>" : `<p style="margin:0 0 4px 0;">${line}</p>`).join("\n")}
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
