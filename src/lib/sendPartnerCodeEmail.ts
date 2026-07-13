// Emails a partner their referral code via Resend. Mirrors the inline Resend
// pattern in convertLead.ts (RESEND_API_KEY, RESEND_FROM_EMAIL fallback,
// replyTo: testing@iclosed.ca).

interface PartnerLike {
  name?: string | null;
  email?: string | null;
  referral_code?: string | null;
}

export async function sendPartnerCodeEmail(
  partner: PartnerLike,
): Promise<{ success: boolean; error?: string }> {
  const email = (partner.email ?? "").trim();
  if (!email) {
    return { success: false, error: "This partner has no email on file." };
  }
  if (!partner.referral_code) {
    return { success: false, error: "This partner has no referral code yet." };
  }

  const firstName = (partner.name ?? "").trim().split(/\s+/)[0] || "there";
  const code = partner.referral_code;

  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #1e293b; max-width: 520px; margin: 0 auto;">
      <p style="font-size: 15px;">Hi ${firstName},</p>
      <p style="font-size: 15px; line-height: 1.6;">
        Thanks for partnering with iClosed. Here is your personal referral code —
        share it with your clients so we can attribute their file to you:
      </p>
      <div style="margin: 24px 0; text-align: center;">
        <span style="display: inline-block; font-family: 'Courier New', monospace; font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #C10007; background: #FEF2F2; border: 1px solid #FECACA; border-radius: 10px; padding: 14px 28px;">
          ${code}
        </span>
      </div>
      <p style="font-size: 14px; line-height: 1.6; color: #475569;">
        Your clients can enter this code when they get started, and any files they
        open will be linked back to you automatically.
      </p>
      <p style="font-size: 14px; color: #475569;">— The iClosed Team</p>
    </div>
  `;

  try {
    await resend.emails.send({
      from: fromEmail,
      replyTo: "testing@iclosed.ca",
      to: [email],
      subject: `Your iClosed referral code: ${code}`,
      html,
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to send email.",
    };
  }
}
