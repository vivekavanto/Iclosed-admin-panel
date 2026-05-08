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
  return new Date(ts).toISOString().slice(0, 10);
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
    outstandingUndertakings: parseIntSafe(raw["Outstanding undertakings"]),
    outstandingRequisitions: parseIntSafe(raw["Outstanding requisitions"]),
    closingDate,
    openingDate,
    status,
    rawDates: {
      requisition: requisitionRaw,
      closing: closingRaw,
      opening: openingRaw,
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
