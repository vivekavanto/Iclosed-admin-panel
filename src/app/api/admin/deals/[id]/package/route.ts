import { NextResponse } from "next/server";
import JSZip from "jszip";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { buildDealPackage, entryFileName, sanitizeEntryName } from "@/lib/dealPackage";

// pdf-lib, the Blob SDK and the service-role client all need Node, and a family
// file with a dozen scanned documents takes real time to fetch and merge.
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/admin/deals/[id]/package
 *
 * "Download All" — the file's whole document package as a ZIP of PDFs, one per
 * entry, flat.
 *
 * The package is built by src/lib/dealPackage.ts, which is also what
 * "Email to Clerk" attaches. That shared origin is the point: the two exports
 * used to enumerate documents independently and disagreed about what was on a
 * file. Whatever changes here changes both.
 *
 * Admin-only: gated by src/middleware.ts (everything under /api/admin/*). Not
 * audited — unlike the clerk email this doesn't push PII anywhere; it hands the
 * signed-in admin the documents they can already open one by one on the page.
 *
 * Responses: the ZIP itself on success, `{ error }` JSON otherwise. Anything the
 * package couldn't retrieve rides on the `X-Package-Failed` header rather than
 * failing the download, so the caller can warn about a partial archive.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid deal id" }, { status: 400 });
  }

  try {
    const pkg = await buildDealPackage(id);
    if (!pkg) return NextResponse.json({ error: "Deal not found" }, { status: 404 });
    if (pkg.entries.length === 0 && pkg.originals.length === 0) {
      return NextResponse.json(
        { error: "No tasks with responses or documents to download" },
        { status: 400 },
      );
    }

    const zip = new JSZip();
    // Two entries can legitimately want the same name — one task carried by two
    // people we have no name for. Number the repeats instead of silently
    // overwriting: a ZIP happily holds duplicate paths, and most extractors then
    // keep only the last one.
    const used = new Set<string>();
    pkg.entries.forEach((entry, i) => {
      const base = entryFileName(pkg.fileNumber, i + 1, entry.title);
      let name = base;
      for (let n = 2; used.has(name); n++) name = base.replace(/\.pdf$/, ` (${n}).pdf`);
      used.add(name);
      zip.file(name, entry.bytes);
    });

    // A HEIC ID or a Word document can't go into a PDF, but it is still a
    // document on this file. It rides in its original form in its own folder, so
    // the archive is complete without disturbing the numbered list above.
    for (const original of pkg.originals) {
      let name = `Originals/${original.fileName}`;
      for (let n = 2; used.has(name); n++) {
        name = `Originals/${n} - ${original.fileName}`;
      }
      used.add(name);
      zip.file(name, original.bytes);
    }

    const body = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const fileName = `Deal ${sanitizeEntryName(pkg.fileNumber || "Documents")} - Documents.zip`;
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
        "X-Package-Entries": String(pkg.entries.length),
        // Header-safe: names can carry anything a client typed, and a bare CR/LF
        // in a header would split the response.
        "X-Package-Failed": encodeURIComponent(pkg.failed.slice(0, 20).join(", ")),
      },
    });
  } catch (err) {
    logger.error(`POST /api/admin/deals/${id}/package error:`, err);
    return NextResponse.json({ error: "Could not build the documents ZIP" }, { status: 500 });
  }
}
