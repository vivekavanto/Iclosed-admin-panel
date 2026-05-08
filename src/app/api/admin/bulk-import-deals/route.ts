import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("deals")
    .select(
      "id, file_number, type, status, property_address, file_name, clerk_name, lawyer_name, requisition_date, outstanding_undertakings, outstanding_requisitions, closing_date, opening_date, created_at",
    )
    .eq("source", "bulk_import")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, deals: data ?? [] });
}

type IncomingRow = {
  index: number;
  fileNumber: string;
  fileType: string;
  fileName: string;
  clerk: string;
  lawyer: string;
  address: string;
  requisitionDate: string | null;
  outstandingUndertakings: number;
  outstandingRequisitions: number;
  closingDate: string | null;
  openingDate: string | null;
  status: string;
};

type ImportOutcome = {
  row: number;
  fileNumber: string;
  outcome: "created" | "updated" | "skipped" | "error";
  reason?: string;
};

const FILE_NUMBER_REGEX = /^[0-9]{2}[A-Z]{1,3}-[0-9]{3,5}$/;
const ALLOWED_TYPES = new Set(["Purchase", "Sale", "Refinance", "Purchase & Sale"]);
const ALLOWED_STATUSES = new Set(["Active", "Closed"]);

// Build the column payload from a CSV row. Optional/blank fields are omitted
// on update so a missing CSV value never blanks out a column that already had
// data — only fields the CSV actually carries are written.
function buildPayload(
  row: IncomingRow,
  fileNumber: string,
  mode: "insert" | "update",
): Record<string, unknown> {
  const status = ALLOWED_STATUSES.has(row.status) ? row.status : "Active";

  const payload: Record<string, unknown> = {
    type: row.fileType,
    status,
    property_address: row.address || "Address TBD",
    outstanding_undertakings: row.outstandingUndertakings ?? 0,
    outstanding_requisitions: row.outstandingRequisitions ?? 0,
  };

  if (row.closingDate) payload.closing_date = row.closingDate;
  if (row.openingDate) payload.opening_date = row.openingDate;
  if (row.requisitionDate) payload.requisition_date = row.requisitionDate;
  if (row.fileName) payload.file_name = row.fileName;
  if (row.clerk) payload.clerk_name = row.clerk;
  if (row.lawyer) payload.lawyer_name = row.lawyer;

  if (mode === "insert") {
    payload.file_number = fileNumber;
    payload.price = 0;
    payload.source = "bulk_import";
  }

  return payload;
}

export async function POST(req: Request) {
  let body: { rows?: IncomingRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ success: true, results: [] });
  }

  const fileNumbers = rows.map((r) => r.fileNumber).filter(Boolean);
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("deals")
    .select("id, file_number")
    .in("file_number", fileNumbers);

  if (existingErr) {
    return NextResponse.json(
      { success: false, error: `Lookup failed: ${existingErr.message}` },
      { status: 500 },
    );
  }

  const existingMap = new Map<string, string>(
    (existing ?? []).map((d) => [d.file_number, d.id]),
  );
  const seenInBatch = new Set<string>();
  const results: ImportOutcome[] = [];

  for (const row of rows) {
    const fileNumber = (row.fileNumber ?? "").trim().toUpperCase();

    if (!fileNumber || !FILE_NUMBER_REGEX.test(fileNumber)) {
      results.push({
        row: row.index,
        fileNumber: fileNumber || "(missing)",
        outcome: "error",
        reason: "Invalid File Number format",
      });
      continue;
    }

    if (!ALLOWED_TYPES.has(row.fileType)) {
      results.push({
        row: row.index,
        fileNumber,
        outcome: "error",
        reason: `Invalid File Type "${row.fileType}"`,
      });
      continue;
    }

    if (seenInBatch.has(fileNumber)) {
      results.push({
        row: row.index,
        fileNumber,
        outcome: "skipped",
        reason: "Duplicate file number within this CSV",
      });
      continue;
    }

    const existingId = existingMap.get(fileNumber);

    if (existingId) {
      const { error: updateErr } = await supabaseAdmin
        .from("deals")
        .update(buildPayload(row, fileNumber, "update"))
        .eq("id", existingId);

      if (updateErr) {
        results.push({
          row: row.index,
          fileNumber,
          outcome: "error",
          reason: updateErr.message,
        });
        continue;
      }

      seenInBatch.add(fileNumber);
      results.push({
        row: row.index,
        fileNumber,
        outcome: "updated",
        reason: "Existing deal updated from CSV",
      });
      continue;
    }

    const { error: insertErr } = await supabaseAdmin
      .from("deals")
      .insert(buildPayload(row, fileNumber, "insert"));

    if (insertErr) {
      const isDup = /duplicate key|unique constraint/i.test(insertErr.message);
      if (isDup) {
        // A concurrent insert beat us. Treat as update path on the next run.
        results.push({
          row: row.index,
          fileNumber,
          outcome: "skipped",
          reason: "File number was created by another request — re-import to update",
        });
      } else {
        results.push({
          row: row.index,
          fileNumber,
          outcome: "error",
          reason: insertErr.message,
        });
      }
      continue;
    }

    seenInBatch.add(fileNumber);
    results.push({ row: row.index, fileNumber, outcome: "created" });
  }

  return NextResponse.json({ success: true, results });
}
