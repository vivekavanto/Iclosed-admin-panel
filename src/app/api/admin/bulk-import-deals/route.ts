import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("deals")
    .select(
      "id, file_number, type, status, property_address, file_name, clerk_name, lawyer_name, requisition_date, outstanding_undertakings, outstanding_requisitions, closing_date, opening_date, created_at",
    )
    .eq("source", "bulk_import")
    .eq("is_deleted", false)
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

// Blank cells in the source sheet arrive as null. Numeric fields use null
// (not 0) to distinguish "user wrote 0" from "cell was blank".
type IncomingRow = {
  index: number;
  fileNumber: string;
  fileType: string | null;
  fileName: string | null;
  clerk: string | null;
  lawyer: string | null;
  address: string | null;
  requisitionDate: string | null;
  outstandingUndertakings: number | null;
  outstandingRequisitions: number | null;
  closingDate: string | null;
  openingDate: string | null;
  status: string | null;
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

function buildInsertPayload(
  row: IncomingRow,
  fileNumber: string,
): Record<string, unknown> {
  const status =
    row.status && ALLOWED_STATUSES.has(row.status) ? row.status : "Active";

  const payload: Record<string, unknown> = {
    file_number: fileNumber,
    type: row.fileType,
    status,
    property_address: row.address || "Address TBD",
    outstanding_undertakings: row.outstandingUndertakings ?? 0,
    outstanding_requisitions: row.outstandingRequisitions ?? 0,
    price: 0,
    source: "bulk_import",
  };

  if (row.closingDate) payload.closing_date = row.closingDate;
  if (row.openingDate) payload.opening_date = row.openingDate;
  if (row.requisitionDate) payload.requisition_date = row.requisitionDate;
  if (row.fileName) payload.file_name = row.fileName;
  if (row.clerk) payload.clerk_name = row.clerk;
  if (row.lawyer) payload.lawyer_name = row.lawyer;

  return payload;
}

// Update payload is purely differential: only fields the sheet explicitly
// carried a value for are written. Blank cells leave existing DB values alone.
function buildUpdatePayload(row: IncomingRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (row.fileType && ALLOWED_TYPES.has(row.fileType)) payload.type = row.fileType;
  if (row.status && ALLOWED_STATUSES.has(row.status)) payload.status = row.status;
  if (row.address) payload.property_address = row.address;
  if (row.outstandingUndertakings !== null && row.outstandingUndertakings !== undefined) {
    payload.outstanding_undertakings = row.outstandingUndertakings;
  }
  if (row.outstandingRequisitions !== null && row.outstandingRequisitions !== undefined) {
    payload.outstanding_requisitions = row.outstandingRequisitions;
  }
  if (row.closingDate) payload.closing_date = row.closingDate;
  if (row.openingDate) payload.opening_date = row.openingDate;
  if (row.requisitionDate) payload.requisition_date = row.requisitionDate;
  if (row.fileName) payload.file_name = row.fileName;
  if (row.clerk) payload.clerk_name = row.clerk;
  if (row.lawyer) payload.lawyer_name = row.lawyer;

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
      const updatePayload = buildUpdatePayload(row);

      if (Object.keys(updatePayload).length === 0) {
        seenInBatch.add(fileNumber);
        results.push({
          row: row.index,
          fileNumber,
          outcome: "skipped",
          reason: "No changes",
        });
        continue;
      }

      const { error: updateErr } = await supabaseAdmin
        .from("deals")
        .update(updatePayload)
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
        reason: "Existing deal updated",
      });
      continue;
    }

    // Insert path keeps strict validation — file type is required for new deals.
    if (!row.fileType || !ALLOWED_TYPES.has(row.fileType)) {
      results.push({
        row: row.index,
        fileNumber,
        outcome: "error",
        reason: `Invalid File Type "${row.fileType ?? ""}"`,
      });
      continue;
    }

    const { error: insertErr } = await supabaseAdmin
      .from("deals")
      .insert(buildInsertPayload(row, fileNumber));

    if (insertErr) {
      const isDup = /duplicate key|unique constraint/i.test(insertErr.message);
      if (isDup) {
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
