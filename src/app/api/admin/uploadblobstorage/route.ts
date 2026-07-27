import supabaseAdmin from "@/lib/supabaseAdmin";
import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { BLOB_ACCESS, blobToken } from "@/lib/blobPrivacy";
import { validateUpload } from "@/lib/uploadValidation";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();

    const file = formData.get("file") as File | null;
    const lead_id = formData.get("lead_id") as string | null;
    const doc_type = formData.get("doc_type") as string | null;
    const custom_type = formData.get("custom_type") as string | null;

    const isIdentificationRaw = formData.get("is_identification");
    const is_identification =
      isIdentificationRaw === "true"
        ? true
        : isIdentificationRaw === "false"
          ? false
          : null;
    const document_type = (formData.get("document_type") as string | null) || null;
    const side = (formData.get("side") as string | null) || null;
    const side_requirement = (formData.get("side_requirement") as string | null) || null;
    const confidence = (formData.get("confidence") as string | null) || null;
    const detection_reason = (formData.get("detection_reason") as string | null) || null;

    if (!file) throw new Error("No file provided");
    if (!lead_id) throw new Error("No lead_id provided");
    if (!doc_type) throw new Error("No doc_type provided");

    // GAP-009: reject oversized or non-document uploads server-side.
    const check = validateUpload(file);
    if (!check.ok) {
      return NextResponse.json(
        { success: false, error: check.error },
        { status: 400 },
      );
    }

    const blob = await put(
      `corporate-docs/${lead_id}/${Date.now()}-${file.name}`,
      file,
      {
        // "public" today; "private" once NEXT_PUBLIC_PRIVATE_BLOB is flipped on
        // (SEC-003). Private uploads are served via /api/admin/documents/download.
        access: BLOB_ACCESS,
        // Private uploads go to the separate private store's token (SEC-003).
        token: blobToken()!,
      },
    );

    const { error } = await supabaseAdmin
      .from("lead_corporate_docs")
      .insert({
        lead_id,
        doc_type,
        custom_type: custom_type || null,
        file_name: file.name,
        file_url: blob.url,
        is_identification,
        document_type,
        side,
        side_requirement,
        confidence,
        detection_reason,
      });

    if (error) {
      // GAP-008: the bytes are already in Blob storage but the DB row failed —
      // delete the blob so it doesn't orphan (and keep costing) forever.
      try {
        // Same store the blob was just written to (public or private).
        await del(blob.url, { token: blobToken() });
      } catch (delErr) {
        console.error("Upload error: failed to clean up orphan blob:", delErr);
      }
      throw new Error(error.message);
    }

    return NextResponse.json({
      success: true,
      url: blob.url,
      file_name: file.name,
    });
  } catch (err: any) {
    console.error("Upload error:", err.message || err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
