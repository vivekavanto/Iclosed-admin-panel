import { ParsedRow, parseFreeTextDate } from "./bulkImportValidation";

export type DealSnapshot = {
  file_number: string;
  type: string | null;
  status: string | null;
  property_address: string | null;
  file_name: string | null;
  clerk_name: string | null;
  lawyer_name: string | null;
  requisition_date: string | null;
  outstanding_undertakings: number | null;
  outstanding_requisitions: number | null;
  closing_date: string | null;
  opening_date: string | null;
};

export type FieldDiff = {
  field: string;
  label: string;
  before: string | number | null;
  after: string | number | null;
};

export type RowOutcome = "error" | "will-create" | "no-change" | "will-update";

const normDate = (v: string | null | undefined): string | null => {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return parseFreeTextDate(v);
};

const normStr = (v: string | null | undefined): string =>
  (v ?? "").trim();

export function computeDiff(
  row: ParsedRow,
  snapshot: DealSnapshot | undefined,
): FieldDiff[] {
  if (!snapshot) return [];

  const diffs: FieldDiff[] = [];

  if (row.rawCells.fileType && row.fileType) {
    const before = normStr(snapshot.type);
    const after = row.fileType;
    if (before !== after) {
      diffs.push({ field: "type", label: "File Type", before: snapshot.type, after });
    }
  }

  if (row.rawCells.status) {
    const before = normStr(snapshot.status);
    const after = row.status;
    if (before !== after) {
      diffs.push({ field: "status", label: "Status", before: snapshot.status, after });
    }
  }

  if (row.rawCells.address) {
    const before = normStr(snapshot.property_address);
    const after = row.address;
    if (before !== after) {
      diffs.push({
        field: "property_address",
        label: "Address",
        before: snapshot.property_address,
        after,
      });
    }
  }

  if (row.rawCells.fileName) {
    const before = normStr(snapshot.file_name);
    const after = row.fileName;
    if (before !== after) {
      diffs.push({
        field: "file_name",
        label: "File Name",
        before: snapshot.file_name,
        after,
      });
    }
  }

  if (row.rawCells.clerk) {
    const before = normStr(snapshot.clerk_name);
    const after = row.clerk;
    if (before !== after) {
      diffs.push({
        field: "clerk_name",
        label: "Clerk",
        before: snapshot.clerk_name,
        after,
      });
    }
  }

  if (row.rawCells.lawyer) {
    const before = normStr(snapshot.lawyer_name);
    const after = row.lawyer;
    if (before !== after) {
      diffs.push({
        field: "lawyer_name",
        label: "Lawyer",
        before: snapshot.lawyer_name,
        after,
      });
    }
  }

  if (row.rawDates.closing && row.closingDate) {
    const before = normDate(snapshot.closing_date);
    const after = row.closingDate;
    if (before !== after) {
      diffs.push({
        field: "closing_date",
        label: "Closing Date",
        before: snapshot.closing_date,
        after,
      });
    }
  }

  if (row.rawDates.opening && row.openingDate) {
    const before = normDate(snapshot.opening_date);
    const after = row.openingDate;
    if (before !== after) {
      diffs.push({
        field: "opening_date",
        label: "Opening Date",
        before: snapshot.opening_date,
        after,
      });
    }
  }

  if (row.rawDates.requisition && row.requisitionDate) {
    const before = normDate(snapshot.requisition_date);
    const after = row.requisitionDate;
    if (before !== after) {
      diffs.push({
        field: "requisition_date",
        label: "Requisition Date",
        before: snapshot.requisition_date,
        after,
      });
    }
  }

  if (row.rawCells.outstandingUndertakings) {
    const before = snapshot.outstanding_undertakings ?? 0;
    const after = row.outstandingUndertakings;
    if (Number(before) !== Number(after)) {
      diffs.push({
        field: "outstanding_undertakings",
        label: "Outstanding Undertakings",
        before: snapshot.outstanding_undertakings,
        after,
      });
    }
  }

  if (row.rawCells.outstandingRequisitions) {
    const before = snapshot.outstanding_requisitions ?? 0;
    const after = row.outstandingRequisitions;
    if (Number(before) !== Number(after)) {
      diffs.push({
        field: "outstanding_requisitions",
        label: "Outstanding Requisitions",
        before: snapshot.outstanding_requisitions,
        after,
      });
    }
  }

  return diffs;
}

export function rowOutcome(
  row: ParsedRow,
  snapshot: DealSnapshot | undefined,
  diff: FieldDiff[],
): RowOutcome {
  if (row.rowStatus === "error") return "error";
  if (!snapshot) return "will-create";
  if (diff.length === 0) return "no-change";
  return "will-update";
}
