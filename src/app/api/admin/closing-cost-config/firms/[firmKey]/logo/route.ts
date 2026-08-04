import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { isBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";
import { isFirmKey } from "@/lib/closingCostSettings";

// The letterhead logo for one firm.
//
//   POST    upload/replace it
//   DELETE  remove it (the statement falls back to the firm-name wordmark)
//
// ── Why a dedicated validator ───────────────────────────────────────────
// `validateUpload` accepts WEBP, HEIC and PDF — correct for client documents,
// wrong here: pdf-lib can embed PNG and JPEG ONLY. Accepting a WEBP would store
// it happily and then silently drop the logo from every statement, which is far
// worse than refusing it at the point of upload.
//
// Gated to admins by src/middleware.ts.

export const runtime = "nodejs";

/** Small — this is a letterhead mark, not a photograph. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/jpg"]);
const ALLOWED_EXT = new Set(["png", "jpg", "jpeg"]);

function validateLogo(file: File): { ok: true } | { ok: false; error: string } {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file provided" };
  }
  if (file.size === 0) return { ok: false, error: "That file is empty" };
  if (file.size > MAX_LOGO_BYTES) {
    return { ok: false, error: "The logo must be 2 MB or smaller" };
  }

  const mime = (file.type || "").toLowerCase();
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  // Either signal is enough — browsers report image MIME types inconsistently.
  if (!ALLOWED_MIME.has(mime) && !ALLOWED_EXT.has(ext)) {
    return {
      ok: false,
      error: "The logo must be a PNG or JPG. SVG and WEBP cannot be printed on the PDF.",
    };
  }
  return { ok: true };
}

/** Best-effort cleanup of the blob a firm used to point at. */
async function deleteBlob(url: unknown) {
  const previous = typeof url === "string" ? url : "";
  if (!previous || !isBlobUrl(previous)) return;
  try {
    await del(previous, { token: blobTokenForUrl(previous) });
  } catch (err) {
    // An orphaned blob is untidy, not broken — never fail the request for it.
    logger.warn("[ClosingCostFirmLogo] could not delete the previous logo:", err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ firmKey: string }> },
) {
  const { firmKey } = await params;
  if (!isFirmKey(firmKey)) {
    return NextResponse.json({ success: false, error: "Unknown firm" }, { status: 404 });
  }

  let file: File | null = null;
  try {
    const formData = await req.formData();
    file = formData.get("file") as File | null;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid upload" },
      { status: 400 },
    );
  }

  if (!file) {
    return NextResponse.json(
      { success: false, error: "Choose a logo file to upload" },
      { status: 400 },
    );
  }

  const check = validateLogo(file);
  if (!check.ok) {
    return NextResponse.json({ success: false, error: check.error }, { status: 400 });
  }

  const { data: firm, error: readErr } = await supabaseAdmin
    .from("closing_cost_config")
    .select("id, logo_url")
    .eq("firm_key", firmKey)
    .eq("is_deleted", false)
    .maybeSingle();

  if (readErr) {
    logger.error("[ClosingCostFirmLogo POST] firm read failed:", readErr.message);
    return NextResponse.json(
      {
        success: false,
        error:
          "Could not load this firm. Run the closing-cost migrations before uploading a logo.",
      },
      { status: 409 },
    );
  }
  if (!firm?.id) {
    return NextResponse.json(
      { success: false, error: "Save this firm before uploading its logo." },
      { status: 409 },
    );
  }

  let uploadedUrl: string;
  try {
    // Deliberately PUBLIC, ignoring NEXT_PUBLIC_PRIVATE_BLOB.
    //
    // That flag exists for client documents — government IDs, agreements — where
    // a leaked URL is a privacy incident. A firm's letterhead logo is the
    // opposite: it is branding printed on every statement the firm sends out,
    // so there is nothing to protect, and storing it privately would mean the
    // settings preview, the admin PDF and the portal PDF each needing an
    // authenticated fetch to render a public-by-definition image.
    const blob = await put(
      `closing-cost-logos/${firmKey}/${Date.now()}-${file.name}`,
      file,
      {
        access: "public",
        token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
      },
    );
    uploadedUrl = blob.url;
  } catch (err) {
    logger.error("[ClosingCostFirmLogo POST] blob upload failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not upload the logo. Please try again." },
      { status: 502 },
    );
  }

  const { data: saved, error } = await supabaseAdmin
    .from("closing_cost_config")
    .update({ logo_url: uploadedUrl, updated_at: new Date().toISOString() })
    .eq("id", firm.id)
    .select("id, firm_key, logo_url")
    .single();

  if (error) {
    // The row never took the new URL, so the blob we just wrote is an orphan.
    logger.error("[ClosingCostFirmLogo POST] update failed:", error.message);
    await deleteBlob(uploadedUrl);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  // Only once the row points at the new blob is the old one safe to remove.
  await deleteBlob(firm.logo_url);

  const actor = await getActingAdmin();
  await recordAudit({
    action: "closing_cost_firm.logo_update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "closing_cost_config",
    resourceId: String(firm.id),
    metadata: { firm_key: firmKey, logo_url: uploadedUrl },
    req,
  });

  return NextResponse.json({ success: true, data: saved });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ firmKey: string }> },
) {
  const { firmKey } = await params;
  if (!isFirmKey(firmKey)) {
    return NextResponse.json({ success: false, error: "Unknown firm" }, { status: 404 });
  }

  const { data: firm } = await supabaseAdmin
    .from("closing_cost_config")
    .select("id, logo_url")
    .eq("firm_key", firmKey)
    .eq("is_deleted", false)
    .maybeSingle();

  if (!firm?.id) {
    return NextResponse.json({ success: false, error: "Unknown firm" }, { status: 404 });
  }

  const { error } = await supabaseAdmin
    .from("closing_cost_config")
    .update({ logo_url: null, updated_at: new Date().toISOString() })
    .eq("id", firm.id);

  if (error) {
    logger.error("[ClosingCostFirmLogo DELETE] update failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  await deleteBlob(firm.logo_url);

  const actor = await getActingAdmin();
  await recordAudit({
    action: "closing_cost_firm.logo_remove",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "closing_cost_config",
    resourceId: String(firm.id),
    metadata: { firm_key: firmKey },
    req,
  });

  return NextResponse.json({ success: true });
}
