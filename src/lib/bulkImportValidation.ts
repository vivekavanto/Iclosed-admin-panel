export const REQUIRED_HEADERS = [
  "File Number",
  "File Type",
  "File Name",
  "Clerk",
  "Lawyer",
  "Address",
  "Requisition date",
  "Outstanding undertakings",
  "Outstanding requisitions",
  "Closing date",
  "Opening date",
  "Status",
] as const;

export type RowStatus = "ready" | "warning" | "error" | "skip";

export interface RawCsvRow {
  "File Number"?: string;
  "File Type"?: string;
  "File Name"?: string;
  Clerk?: string;
  Lawyer?: string;
  Address?: string;
  "Requisition date"?: string;
  "Outstanding undertakings"?: string;
  "Outstanding requisitions"?: string;
  "Closing date"?: string;
  "Opening date"?: string;
  Status?: string;
}

export interface ParsedRow {
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
  rawDates: {
    requisition: string;
    closing: string;
    opening: string;
  };
  rawCells: {
    fileType: string;
    fileName: string;
    clerk: string;
    lawyer: string;
    address: string;
    status: string;
    outstandingUndertakings: string;
    outstandingRequisitions: string;
  };
  problems: { level: "error" | "warning"; field: string; message: string }[];
  rowStatus: RowStatus;
  skipReason?: string;
}

const FILE_NUMBER_REGEX = /^[0-9]{2}[A-Z]{1,3}-[0-9]{3,5}$/;
const FILE_TYPE_MAP: Record<string, string> = {
  purchase: "Purchase",
  sale: "Sale",
  refinance: "Refinance",
};
const STATUS_MAP: Record<string, string> = {
  closed: "Closed",
  active: "Active",
};

export function normalizeFileType(value: string): string | null {
  const key = (value ?? "").trim().toLowerCase();
  return FILE_TYPE_MAP[key] ?? null;
}

export function normalizeStatus(value: string): { status: string; recognized: boolean } {
  const key = (value ?? "").trim().toLowerCase();
  if (STATUS_MAP[key]) return { status: STATUS_MAP[key], recognized: true };
  return { status: "Active", recognized: false };
}

export function parseFreeTextDate(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  const year = d.getFullYear();
  // Reject obviously-malformed input (e.g. "Feb 3, 202323" parses as a
  // 6-digit year and would later render as garbage in the UI).
  if (year < 1900 || year > 2200) return null;
  const yyyy = String(year).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseIntSafe(value: string | undefined | null): number {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return 0;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? 0 : n;
}

export function checkHeaders(headers: string[]): string[] {
  const present = new Set(headers.map((h) => h.trim()));
  return REQUIRED_HEADERS.filter((h) => !present.has(h));
}

export function parseRow(raw: RawCsvRow, index: number): ParsedRow {
  const problems: ParsedRow["problems"] = [];

  const fileNumber = (raw["File Number"] ?? "").trim().toUpperCase();
  const fileTypeRaw = (raw["File Type"] ?? "").trim();
  const fileName = (raw["File Name"] ?? "").trim();
  const clerk = (raw.Clerk ?? "").trim();
  const lawyer = (raw.Lawyer ?? "").trim();
  const address = (raw.Address ?? "").trim();
  const requisitionRaw = (raw["Requisition date"] ?? "").trim();
  const closingRaw = (raw["Closing date"] ?? "").trim();
  const openingRaw = (raw["Opening date"] ?? "").trim();
  const statusRaw = (raw.Status ?? "").trim();
  const outstandingUndertakingsRaw = (raw["Outstanding undertakings"] ?? "").trim();
  const outstandingRequisitionsRaw = (raw["Outstanding requisitions"] ?? "").trim();

  if (!fileNumber) {
    problems.push({ level: "error", field: "File Number", message: "File Number is required" });
  } else if (!FILE_NUMBER_REGEX.test(fileNumber)) {
    problems.push({
      level: "error",
      field: "File Number",
      message: `Invalid format. Expected like "26P-0194"`,
    });
  }

  const normalizedFileType = normalizeFileType(fileTypeRaw);
  if (!fileTypeRaw) {
    problems.push({ level: "error", field: "File Type", message: "File Type is required" });
  } else if (!normalizedFileType) {
    problems.push({
      level: "error",
      field: "File Type",
      message: `Must be Purchase, Sale, or Refinance`,
    });
  }

  if (!fileName) {
    problems.push({ level: "error", field: "File Name", message: "File Name is required" });
  }
  if (!clerk) {
    problems.push({ level: "error", field: "Clerk", message: "Clerk is required" });
  }
  if (!lawyer) {
    problems.push({ level: "error", field: "Lawyer", message: "Lawyer is required" });
  }
  if (!address) {
    problems.push({ level: "error", field: "Address", message: "Address is required" });
  }

  const closingDate = parseFreeTextDate(closingRaw);
  if (closingRaw && !closingDate) {
    problems.push({ level: "warning", field: "Closing date", message: `Could not parse "${closingRaw}"` });
  }
  const openingDate = parseFreeTextDate(openingRaw);
  if (openingRaw && !openingDate) {
    problems.push({ level: "warning", field: "Opening date", message: `Could not parse "${openingRaw}"` });
  }
  const requisitionDate = parseFreeTextDate(requisitionRaw);
  if (requisitionRaw && !requisitionDate) {
    problems.push({ level: "warning", field: "Requisition date", message: `Could not parse "${requisitionRaw}"` });
  }

  const { status, recognized } = normalizeStatus(statusRaw);
  if (statusRaw && !recognized) {
    problems.push({
      level: "warning",
      field: "Status",
      message: `Unrecognized status "${statusRaw}", defaulting to Active`,
    });
  }

  const hasError = problems.some((p) => p.level === "error");
  const hasWarning = problems.some((p) => p.level === "warning");

  return {
    index,
    fileNumber,
    fileType: normalizedFileType ?? fileTypeRaw,
    fileName,
    clerk,
    lawyer,
    address,
    requisitionDate,
    outstandingUndertakings: parseIntSafe(outstandingUndertakingsRaw),
    outstandingRequisitions: parseIntSafe(outstandingRequisitionsRaw),
    closingDate,
    openingDate,
    status,
    rawDates: {
      requisition: requisitionRaw,
      closing: closingRaw,
      opening: openingRaw,
    },
    rawCells: {
      fileType: fileTypeRaw,
      fileName,
      clerk,
      lawyer,
      address,
      status: statusRaw,
      outstandingUndertakings: outstandingUndertakingsRaw,
      outstandingRequisitions: outstandingRequisitionsRaw,
    },
    problems,
    rowStatus: hasError ? "error" : hasWarning ? "warning" : "ready",
  };
}

/**
 * Apply within-file de-duplication: same File Number twice → first wins,
 * subsequent rows are flagged as `skip` with reason "duplicate within file".
 */
export function flagDuplicates(rows: ParsedRow[]): ParsedRow[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    if (row.rowStatus === "error" || !row.fileNumber) return row;
    const key = row.fileNumber;
    if (seen.has(key)) {
      return { ...row, rowStatus: "skip" as const, skipReason: "duplicate within file" };
    }
    seen.add(key);
    return row;
  });
}

export function summarize(rows: ParsedRow[]) {
  return {
    total: rows.length,
    ready: rows.filter((r) => r.rowStatus === "ready").length,
    warnings: rows.filter((r) => r.rowStatus === "warning").length,
    errors: rows.filter((r) => r.rowStatus === "error").length,
    skips: rows.filter((r) => r.rowStatus === "skip").length,
  };
}

const COMPLETENESS_FIELDS = new Set(["File Name", "Clerk", "Lawyer", "Address"]);

/**
 * For rows whose file_number already exists in the deals table, drop
 * "is required" errors on the optional-on-update fields (Clerk, Lawyer,
 * Address, File Name). Structural errors — bad File Number format, bad
 * File Type — are preserved. Recomputes rowStatus from the filtered
 * problems list.
 */
export function relaxRequiredForExisting(
  rows: ParsedRow[],
  existingFileNumbers: Set<string>,
): ParsedRow[] {
  return rows.map((row) => {
    if (row.rowStatus === "skip") return row;
    if (!row.fileNumber || !existingFileNumbers.has(row.fileNumber)) return row;

    const filtered = row.problems.filter((p) => {
      if (p.level !== "error") return true;
      if (!COMPLETENESS_FIELDS.has(p.field)) return true;
      return !/is required$/.test(p.message);
    });

    if (filtered.length === row.problems.length) return row;

    const hasError = filtered.some((p) => p.level === "error");
    const hasWarning = filtered.some((p) => p.level === "warning");

    return {
      ...row,
      problems: filtered,
      rowStatus: hasError ? "error" : hasWarning ? "warning" : "ready",
    };
  });
}
