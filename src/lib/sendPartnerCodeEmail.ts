// Emails a partner their referral code via Resend. Mirrors the inline Resend
// pattern in convertLead.ts (RESEND_API_KEY, plus the shared from/reply-to
// addresses from emailIdentity.ts).

import { normalizeRecipientEmail } from "./emailIdentity";
import { sendEmail } from "./email/emailTransport";

interface PartnerLike {
  agent_name?: string | null;
  agent_email?: string | null;
  referral_code?: string | null;
}

export async function sendPartnerCodeEmail(
  partner: PartnerLike,
): Promise<{ success: boolean; error?: string }> {
  const email = (partner.agent_email ?? "").trim();
  if (!email) {
    return { success: false, error: "This partner has no email on file." };
  }
  if (!partner.referral_code) {
    return { success: false, error: "This partner has no referral code yet." };
  }

  const firstName = (partner.agent_name ?? "").trim().split(/\s+/)[0] || "there";
  const code = partner.referral_code;

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

  // A partner belongs to no file, so there is no firm — `firm: null` keeps the
  // legacy firm-agnostic sender this email has always used, and pins it to
  // Resend regardless of any SMTP rollout.
  //
  // The old code awaited the send and DISCARDED its { data, error }, returning
  // success unconditionally; only a thrown transport error was ever reported.
  const result = await sendEmail(
    {
      to: [normalizeRecipientEmail(email)],
      subject: `Your iClosed referral code: ${code}`,
      html,
    },
    { firm: null, label: "partner-code" },
  );

  return result.ok
    ? { success: true }
    : { success: false, error: result.error || "Failed to send email." };
}
