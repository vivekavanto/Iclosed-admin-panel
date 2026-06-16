import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { consumeInvitationToken } from "@/lib/invitationToken";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/retainer-signed
 *
 * Called by the customer portal immediately after it records a retainer
 * signature (writes retainer_signatures + the generated PDF into
 * lead_corporate_docs). Lives under /api/webhooks/* so it is public by
 * construction (outside the middleware matcher).
 *
 * Auth: the same retainer-sign `token` the portal received in the link. We
 * validate it against invitation_tokens (type 'retainer_sign') and take
 * lead_id / side from the token's stored scope — never from the body — so a
 * caller can't acknowledge a signature for someone else.
 *
 * Responsibilities:
 *   1. Validate the token (existence + 7-day expiry + correct type).
 *   2. Confirm a signature row exists for (lead_id, side) — the portal should
 *      have written it first; this guards against a premature callback.
 *   3. Record the "Activate your account" / "I'll do this later" choice on the
 *      lead so the admin can target deferred-but-signed parties for reminders.
 *
 * It deliberately does NOT send the "Retainer Agreement Signed" family email —
 * that path is owned by the existing /api/admin/send-lead-family-email flow the
 * portal already calls, and firing it here too would double-send.
 *
 * Body: { token: string, choice?: "activate" | "later" }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      token?: string;
      choice?: "activate" | "later";
    };

    const consumed = await consumeInvitationToken(body.token ?? "");
    if (!consumed.ok) {
      const status = consumed.reason === "expired" ? 410 : 401;
      return NextResponse.json(
        { success: false, error: `Invalid retainer token: ${consumed.reason}` },
        { status },
      );
    }
    if (consumed.data.type !== "retainer_sign") {
      return NextResponse.json(
        { success: false, error: "Token is not a retainer signing token" },
        { status: 401 },
      );
    }

    const ud = consumed.data.userData ?? {};
    const lead_id = String(ud.lead_id ?? "");
    const side = String(ud.side ?? "");
    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "Token missing lead scope" },
        { status: 400 },
      );
    }

    // Confirm the signature exists for this lead (and side, when scoped).
    let sigQuery = supabaseAdmin
      .from("retainer_signatures")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", lead_id);
    if (side === "purchase" || side === "sale") {
      sigQuery = sigQuery.eq("side", side);
    }
    const { count: sigCount, error: sigErr } = await sigQuery;

    if (sigErr) {
      return NextResponse.json(
        { success: false, error: sigErr.message },
        { status: 500 },
      );
    }
    if (!sigCount || sigCount < 1) {
      return NextResponse.json(
        {
          success: false,
          error: "No retainer signature found for this lead/side yet",
        },
        { status: 409 },
      );
    }

    // Record the activation choice. "later" flags the lead for the reminder
    // set; "activate" clears it (the activate-now webhook does the real work).
    if (body.choice === "later" || body.choice === "activate") {
      const { error: updErr } = await supabaseAdmin
        .from("leads")
        .update({ account_activation_deferred: body.choice === "later" })
        .eq("id", lead_id);
      if (updErr) {
        // Non-fatal: the signature is recorded; only the reminder flag failed.
        console.warn(
          "[RetainerSigned] failed to record activation choice (non-blocking):",
          updErr.message,
        );
      }
    }

    return NextResponse.json({
      success: true,
      lead_id,
      side: side || null,
      choice: body.choice ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    console.error("POST /api/webhooks/retainer-signed error:", err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
