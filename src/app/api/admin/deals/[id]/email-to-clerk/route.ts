import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { sendClerkDocumentsEmail } from "@/lib/sendClerkDocumentsEmail";

/**
 * POST /api/admin/deals/[id]/email-to-clerk
 *
 * Emails every client document on the file to the firm's conveyancing clerk
 * inbox — purchase@ / sale@ / both, chosen by the file's type.
 *
 * The clerks asked for the per-person paperwork MERGED, so identification and
 * personal information go out as two combined PDFs — every party's ID in one,
 * every party's details in the other. Every other document keeps its own
 * attachment and its original formatting, which merging would break.
 * ("Download All" on the deal page packages the file exactly the same way.)
 *
 * Admin-only: gated by src/middleware.ts (everything under /api/admin/*).
 *
 * Audited — this pushes client PII out of the system to an external mailbox,
 * so the send is recorded like impersonation and deletion are.
 *
 * Body: none. Everything is derived from the deal.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  try {
    const result = await sendClerkDocumentsEmail(id);

    if (!result.success) {
      // These are user-actionable messages ("no documents yet", "no clerk inbox
      // for this file type"), so they're safe and useful to surface verbatim —
      // this route is admin-only.
      return NextResponse.json(
        { success: false, error: result.error ?? "Could not send the email" },
        { status: 400 },
      );
    }

    const actor = await getActingAdmin();
    await recordAudit({
      action: "deal.documents_emailed_to_clerk",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "deal",
      resourceId: id,
      metadata: {
        recipients: result.recipients,
        attached: result.attached,
        linked: result.linked,
        identification: result.identification,
        personalInfo: result.personalInfo,
      },
      req,
    });

    return NextResponse.json({
      success: true,
      recipients: result.recipients,
      attached: result.attached,
      linked: result.linked,
      identification: result.identification,
      personalInfo: result.personalInfo,
    });
  } catch (err) {
    logger.error(`POST /api/admin/deals/${id}/email-to-clerk error:`, err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
