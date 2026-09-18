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
 * The clerks asked for the paperwork MERGED: identification, the agreement of
 * purchase and sale, and personal information go out as three combined PDFs —
 * every party's ID in one, the file's agreement(s) in another, every party's
 * details in the third — alongside a property-information PDF carrying the lock
 * box code and the rental equipment answers. Every other task goes out as one
 * PDF holding its answers and every file uploaded against it. Anything that
 * can't be embedded still travels as its own original file.
 *
 * "Download All" on the deal page ships the identical package as a ZIP; both are
 * built by src/lib/dealPackage.ts.
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
        aps: result.aps,
        personalInfo: result.personalInfo,
        propertyInfo: result.propertyInfo,
        // Empty on a healthy send. Recorded so that "some documents were missing
        // from the clerk email" is answerable after the fact rather than a
        // forensic exercise against a mailbox nobody here can read.
        uncovered: result.uncovered,
      },
      req,
    });

    return NextResponse.json({
      success: true,
      recipients: result.recipients,
      attached: result.attached,
      linked: result.linked,
      identification: result.identification,
      aps: result.aps,
      personalInfo: result.personalInfo,
      propertyInfo: result.propertyInfo,
      uncovered: result.uncovered,
    });
  } catch (err) {
    logger.error(`POST /api/admin/deals/${id}/email-to-clerk error:`, err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
