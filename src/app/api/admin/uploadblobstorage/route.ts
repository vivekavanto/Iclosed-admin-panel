import supabaseAdmin from "@/lib/supabaseAdmin";
import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { BLOB_ACCESS, blobToken, blobTokenForUrl } from "@/lib/blobPrivacy";
import {
  validateUpload,
  validateUploadMeta,
  maxUploadBytesForDocType,
} from "@/lib/uploadValidation";
import { readBlobMeta, BlobDocumentError } from "@/lib/blobDocument";

// This route has TWO request modes:
//
//   1. JSON  { file_url, file_name, lead_id, doc_type, … }  ← preferred
//      The browser already uploaded the bytes straight to Vercel Blob using a
//      token from ./token, so all we do is validate the stored blob and write
//      the lead_corporate_docs row. Nothing large crosses the function boundary,
//      which is what lifts the effective upload ceiling from ~4.5 MB (Vercel's
//      request-body cap) to the full 10 MB the app advertises.
//
//   2. multipart/form-data with a `file`  ← legacy, unchanged
//      Kept so any existing caller keeps working. Still subject to Vercel's
//      ~4.5 MB body limit, which is exactly why mode 1 exists.
//
// Both modes produce an IDENTICAL database row and an identical response shape,
// so everything downstream (task_responses, the Doc column, the PDF export, the
// download proxy) is untouched.

interface DocFields {
  lead_id: string;
  doc_type: string;
  custom_type: string | null;
  is_identification: boolean | null;
  document_type: string | null;
  side: string | null;
  side_requirement: string | null;
  confidence: string | null;
  detection_reason: string | null;
}

function parseIsIdentification(raw: unknown): boolean | null {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return null;
}

async function insertDocRow(
  fields: DocFields,
  file_name: string,
  file_url: string,
  file_size: number | null,
) {
  return supabaseAdmin.from("lead_corporate_docs").insert({
    lead_id: fields.lead_id,
    doc_type: fields.doc_type,
    custom_type: fields.custom_type || null,
    file_name,
    file_url,
    file_size,
    is_identification: fields.is_identification,
    document_type: fields.document_type,
    side: fields.side,
    side_requirement: fields.side_requirement,
    confidence: fields.confidence,
    detection_reason: fields.detection_reason,
  });
}

/** Mode 1: the bytes are already in Blob; record them. */
async function registerUploadedBlob(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;

  const file_url = typeof body.file_url === "string" ? body.file_url : "";
  const lead_id = typeof body.lead_id === "string" ? body.lead_id : "";
  const doc_type = typeof body.doc_type === "string" ? body.doc_type : "";

  if (!file_url) {
    return NextResponse.json(
      { success: false, error: "No file_url provided" },
      { status: 400 },
    );
  }
  if (!lead_id) {
    return NextResponse.json(
      { success: false, error: "No lead_id provided" },
      { status: 400 },
    );
  }
  if (!doc_type) {
    return NextResponse.json(
      { success: false, error: "No doc_type provided" },
      { status: 400 },
    );
  }

  // Validate the STORED blob, not what the client claims about it: head() is the
  // source of truth for size and content type, and readBlobMeta() also enforces
  // the "must be a Vercel Blob URL" guard so an arbitrary URL can never be
  // recorded as a document.
  let meta;
  try {
    meta = await readBlobMeta(file_url);
  } catch (err: unknown) {
    if (err instanceof BlobDocumentError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    throw err;
  }

  const fallbackName = decodeURIComponent(meta.pathname.split("/").pop() || "document");
  const file_name =
    typeof body.file_name === "string" && body.file_name.trim()
      ? body.file_name.trim()
      : fallbackName;

  // Same ceiling the token route minted the upload under — a final reporting
  // package gets MAX_FINAL_REPORT_BYTES, everything else the document cap.
  const check = validateUploadMeta(
    { name: file_name, size: meta.size, type: meta.contentType },
    maxUploadBytesForDocType(doc_type),
    doc_type,
  );
  if (!check.ok) {
    // The blob exists but isn't something we'll accept — drop it rather than
    // leaving unreferenced bytes in the store.
    try {
      await del(file_url, { token: blobTokenForUrl(file_url) });
    } catch (delErr) {
      console.error("Upload error: failed to clean up rejected blob:", delErr);
    }
    return NextResponse.json(
      { success: false, error: check.error },
      { status: 400 },
    );
  }

  const fields: DocFields = {
    lead_id,
    doc_type,
    custom_type: typeof body.custom_type === "string" ? body.custom_type : null,
    is_identification: parseIsIdentification(body.is_identification),
    document_type: typeof body.document_type === "string" ? body.document_type : null,
    side: typeof body.side === "string" ? body.side : null,
    side_requirement:
      typeof body.side_requirement === "string" ? body.side_requirement : null,
    confidence: typeof body.confidence === "string" ? body.confidence : null,
    detection_reason:
      typeof body.detection_reason === "string" ? body.detection_reason : null,
  };

  const { error } = await insertDocRow(fields, file_name, file_url, meta.size ?? null);

  if (error) {
    // GAP-008: the bytes are in Blob storage but the DB row failed — delete the
    // blob so it doesn't orphan (and keep costing) forever.
    try {
      await del(file_url, { token: blobTokenForUrl(file_url) });
    } catch (delErr) {
      console.error("Upload error: failed to clean up orphan blob:", delErr);
    }
    throw new Error(error.message);
  }

  return NextResponse.json({ success: true, url: file_url, file_name });
}

/** Mode 2: legacy multipart upload (bytes through the function). */
async function uploadMultipart(req: Request) {
  const formData = await req.formData();

  const file = formData.get("file") as File | null;
  const lead_id = formData.get("lead_id") as string | null;
  const doc_type = formData.get("doc_type") as string | null;
  const custom_type = formData.get("custom_type") as string | null;

  const is_identification = parseIsIdentification(formData.get("is_identification"));
  const document_type = (formData.get("document_type") as string | null) || null;
  const side = (formData.get("side") as string | null) || null;
  const side_requirement = (formData.get("side_requirement") as string | null) || null;
  const confidence = (formData.get("confidence") as string | null) || null;
  const detection_reason = (formData.get("detection_reason") as string | null) || null;

  if (!file) throw new Error("No file provided");
  if (!lead_id) throw new Error("No lead_id provided");
  if (!doc_type) throw new Error("No doc_type provided");

  // GAP-009: reject oversized or non-document uploads server-side. Same
  // per-doc_type cap and allow-list as the direct-to-Blob path below.
  const check = validateUpload(file, doc_type);
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

  const { error } = await insertDocRow(
    {
      lead_id,
      doc_type,
      custom_type,
      is_identification,
      document_type,
      side,
      side_requirement,
      confidence,
      detection_reason,
    },
    file.name,
    blob.url,
    file.size,
  );

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
}

export async function POST(req: Request) {
  try {
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    return contentType.includes("application/json")
      ? await registerUploadedBlob(req)
      : await uploadMultipart(req);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    console.error("Upload error:", message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/uploadblobstorage?url=<blob-url>
 *
 * Discards a blob that was client-uploaded but never registered — e.g. the user
 * removed the file from the drawer, or closed it without saving. Because the
 * bytes now land in Blob at PICK time (they have to, so identification can read
 * them back), abandoning the drawer would otherwise leak storage.
 *
 * Refuses to delete anything a lead_corporate_docs row points at, so this can
 * never be used to destroy a saved document.
 */
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url).searchParams.get("url");
    if (!url) {
      return NextResponse.json(
        { success: false, error: "url is required" },
        { status: 400 },
      );
    }

    let meta;
    try {
      meta = await readBlobMeta(url);
    } catch (err: unknown) {
      if (err instanceof BlobDocumentError) {
        // Already gone (or never a blob URL) — nothing to clean up.
        return NextResponse.json({ success: true, deleted: false });
      }
      throw err;
    }

    const { data: referencing, error } = await supabaseAdmin
      .from("lead_corporate_docs")
      .select("id")
      .eq("file_url", meta.url)
      .limit(1);

    if (error) throw new Error(error.message);
    if (referencing && referencing.length > 0) {
      return NextResponse.json(
        { success: false, error: "This document is already saved and cannot be discarded here." },
        { status: 409 },
      );
    }

    await del(meta.url, { token: blobTokenForUrl(meta.url) });
    return NextResponse.json({ success: true, deleted: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    console.error("Discard upload error:", message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
