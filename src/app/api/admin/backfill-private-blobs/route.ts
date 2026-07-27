import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isPrivateBlobUrl } from "@/lib/blobPrivacy";

/**
 * POST /api/admin/backfill-private-blobs
 *
 * One-off migration for SEC-003 / CMP-001: copies every document still sitting in
 * PUBLIC Vercel Blob over to a PRIVATE blob, repoints the DB rows, and deletes the
 * public original. After this runs (and NEXT_PUBLIC_PRIVATE_BLOB is on for new
 * uploads), no PII document is publicly readable by URL anymore.
 *
 * Gated by the admin auth middleware (this is under /api/admin/*). Safe to run
 * repeatedly — already-private URLs are skipped, so it is idempotent and
 * resumable if interrupted.
 *
 * PREREQUISITE: both apps (admin + portal) must already be DEPLOYED with the
 * download-proxy code before running this. Once a blob is private, only the proxy
 * can read it — an old deploy that still links the raw URL would break. See the
 * "Private-document rollout runbook" in docs/iClosed-Security-Remediation-Tracker.md.
 *
 * Body (JSON, all optional):
 *   { dryRun?: boolean (default TRUE), limit?: number (default 100) }
 * Nothing is mutated unless you explicitly pass { "dryRun": false }.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

type RowRef = { table: "lead_corporate_docs" | "task_responses"; id: string };

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun !== false; // default TRUE — must opt in to mutate
  const limit =
    Number.isFinite(body?.limit) && body.limit > 0 ? Math.min(body.limit, 1000) : 100;

  // This tool reads PUBLIC bytes, re-uploads them PRIVATE, then deletes the
  // public original — so it needs BOTH store tokens (2-token setup, SEC-003):
  // publicToken to delete the old blob, privateToken to write the new one.
  if (
    !process.env.BLOB_PUBLIC_READ_WRITE_TOKEN ||
    !process.env.BLOB_PRIVATE_READ_WRITE_TOKEN
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Both BLOB_PUBLIC_READ_WRITE_TOKEN and BLOB_PRIVATE_READ_WRITE_TOKEN must be configured",
      },
      { status: 500 },
    );
  }
  const publicToken = process.env.BLOB_PUBLIC_READ_WRITE_TOKEN;
  const privateToken = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;

  // 1. Collect every distinct PUBLIC blob URL referenced by either table, and
  //    remember which rows point at it so we can repoint them all together.
  const urlToRows = new Map<string, RowRef[]>();

  for (const table of ["lead_corporate_docs", "task_responses"] as const) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("id, file_url")
      .not("file_url", "is", null);
    if (error) {
      return NextResponse.json(
        { success: false, error: `Failed to read ${table}: ${error.message}` },
        { status: 500 },
      );
    }
    for (const row of data ?? []) {
      const url = (row as any).file_url as string | null;
      if (!url) continue;
      // Only public Vercel Blob URLs need migrating. Skip already-private ones
      // (idempotent) and anything that isn't a public blob URL.
      if (!isPublicBlobUrl(url)) continue;
      const refs = urlToRows.get(url) ?? [];
      refs.push({ table, id: (row as any).id as string });
      urlToRows.set(url, refs);
    }
  }

  const allUrls = Array.from(urlToRows.keys());
  const targets = allUrls.slice(0, limit);

  const result = {
    success: true,
    dryRun,
    totalPublicUrls: allUrls.length,
    processed: 0,
    migrated: 0,
    rowsRepointed: 0,
    skipped: 0,
    errors: [] as { url: string; error: string }[],
    remainingAfterThisRun: Math.max(0, allUrls.length - targets.length),
  };

  for (const url of targets) {
    result.processed++;
    const refs = urlToRows.get(url) ?? [];

    if (dryRun) {
      // Report what WOULD happen without touching blob storage or the DB.
      result.migrated++;
      result.rowsRepointed += refs.length;
      continue;
    }

    try {
      // a. Download the current public bytes.
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`download failed (HTTP ${res.status})`);
      }
      const contentType =
        res.headers.get("content-type") || "application/octet-stream";
      const bytes = Buffer.from(await res.arrayBuffer());

      // b. Re-upload to a PRIVATE blob at the same pathname.
      const pathname = new URL(url).pathname.replace(/^\/+/, "");
      const uploaded = await put(pathname, bytes, {
        access: "private",
        token: privateToken,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      if (!isPrivateBlobUrl(uploaded.url)) {
        // Defensive: never repoint rows at a still-public URL.
        throw new Error(`re-upload did not return a private URL (${uploaded.url})`);
      }

      // c. Repoint every referencing row (both tables) to the private URL.
      for (const ref of refs) {
        const { error: upErr } = await supabaseAdmin
          .from(ref.table)
          .update({ file_url: uploaded.url })
          .eq("id", ref.id);
        if (upErr) throw new Error(`repoint ${ref.table}:${ref.id} — ${upErr.message}`);
        result.rowsRepointed++;
      }

      // d. Delete the public original only after the DB is safely repointed.
      await del(url, { token: publicToken });

      result.migrated++;
    } catch (err: any) {
      result.errors.push({ url, error: err?.message ?? "unknown error" });
    }
  }

  return NextResponse.json(result);
}

// A public Vercel Blob URL: host is "<store>.public.blob.vercel-storage.com".
function isPublicBlobUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}
