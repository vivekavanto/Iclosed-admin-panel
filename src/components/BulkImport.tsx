"use client";

import React, { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  X,
  Download,
  RotateCcw,
} from "lucide-react";
import {
  REQUIRED_HEADERS,
  RawCsvRow,
  ParsedRow,
  RowStatus,
  parseRow,
  flagDuplicates,
  summarize,
  checkHeaders,
} from "@/lib/bulkImportValidation";

type Stage = "picker" | "preview" | "result";

interface ImportResult {
  row: number;
  fileNumber: string;
  outcome: "created" | "updated" | "skipped" | "error";
  reason?: string;
  type?: string;
  status?: string;
  address?: string;
  clerk?: string;
  lawyer?: string;
  closingDate?: string | null;
}

interface RecentImportRow {
  id: string;
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
  created_at: string;
}

const SAMPLE_CSV_HEADER = REQUIRED_HEADERS.join(",") + "\n";

const BulkImport: React.FC = () => {
  const [stage, setStage] = useState<Stage>("picker");
  const [fileName, setFileName] = useState<string>("");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [missingHeaders, setMissingHeaders] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [recentRefreshKey, setRecentRefreshKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStage("picker");
    setFileName("");
    setParsedRows([]);
    setMissingHeaders([]);
    setParseError(null);
    setImportResults([]);
    setIsImporting(false);
    setImportError(null);
    setRecentRefreshKey((k) => k + 1);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFile = (file: File) => {
    setFileName(file.name);
    setParseError(null);
    setMissingHeaders([]);

    Papa.parse<RawCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: (result) => {
        const headers = result.meta.fields ?? [];
        const missing = checkHeaders(headers);
        if (missing.length > 0) {
          setMissingHeaders(missing);
          setStage("preview");
          return;
        }
        const rows = (result.data ?? []).map((raw, i) => parseRow(raw, i + 2));
        setParsedRows(flagDuplicates(rows));
        setStage("preview");
      },
      error: (err) => {
        setParseError(err.message);
        setStage("preview");
      },
    });
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const downloadSample = async () => {
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    let body = SAMPLE_CSV_HEADER;
    try {
      const res = await fetch("/api/admin/bulk-import-deals");
      const payload = await res.json().catch(() => ({}));
      const deals: RecentImportRow[] = Array.isArray(payload?.deals)
        ? payload.deals
        : [];

      const lines = deals.map((d) =>
        [
          d.file_number,
          d.type,
          d.file_name,
          d.clerk_name,
          d.lawyer_name,
          d.property_address,
          d.requisition_date,
          d.outstanding_undertakings,
          d.outstanding_requisitions,
          d.closing_date,
          d.opening_date,
          d.status,
        ]
          .map(escape)
          .join(","),
      );

      if (lines.length > 0) body = SAMPLE_CSV_HEADER + lines.join("\n") + "\n";
    } catch {
      // fall back to header-only
    }

    const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bulk-imported-deals.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importableRows = parsedRows.filter(
    (r) => r.rowStatus === "ready" || r.rowStatus === "warning",
  );

  const runImport = async () => {
    setIsImporting(true);
    setImportError(null);

    const localResults: ImportResult[] = [];
    const sendable: ParsedRow[] = [];

    const rowDetails = (r: ParsedRow) => ({
      type: r.fileType,
      status: r.status,
      address: r.address,
      clerk: r.clerk,
      lawyer: r.lawyer,
      closingDate: r.closingDate,
    });

    for (const r of parsedRows) {
      if (r.rowStatus === "error") {
        localResults.push({
          row: r.index,
          fileNumber: r.fileNumber || "(missing)",
          outcome: "error",
          reason: r.problems
            .filter((p) => p.level === "error")
            .map((p) => p.message)
            .join("; "),
          ...rowDetails(r),
        });
      } else if (r.rowStatus === "skip") {
        localResults.push({
          row: r.index,
          fileNumber: r.fileNumber,
          outcome: "skipped",
          reason: r.skipReason,
          ...rowDetails(r),
        });
      } else {
        sendable.push(r);
      }
    }

    try {
      const res = await fetch("/api/admin/bulk-import-deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: sendable.map((r) => ({
            index: r.index,
            fileNumber: r.fileNumber,
            fileType: r.fileType,
            fileName: r.fileName,
            clerk: r.clerk,
            lawyer: r.lawyer,
            address: r.address,
            requisitionDate: r.requisitionDate,
            outstandingUndertakings: r.outstandingUndertakings,
            outstandingRequisitions: r.outstandingRequisitions,
            closingDate: r.closingDate,
            openingDate: r.openingDate,
            status: r.status,
          })),
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.success === false) {
        const msg = payload?.error ?? `Import failed (HTTP ${res.status})`;
        setImportError(msg);
        setIsImporting(false);
        return;
      }

      const serverResults: ImportResult[] = Array.isArray(payload?.results)
        ? payload.results
        : [];

      const sendableByIndex = new Map(sendable.map((r) => [r.index, r]));
      const enrichedServerResults = serverResults.map((sr) => {
        const src = sendableByIndex.get(sr.row);
        return src ? { ...sr, ...rowDetails(src) } : sr;
      });

      const combined = [...localResults, ...enrichedServerResults].sort(
        (a, b) => a.row - b.row,
      );
      setImportResults(combined);
      setStage("result");
      setRecentRefreshKey((k) => k + 1);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Network error");
    } finally {
      setIsImporting(false);
    }
  };

  const summary = summarize(parsedRows);

  return (
    <div className="max-w-6xl mx-auto py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Bulk Import Deals</h1>
        <p className="text-sm text-slate-500 mt-1">
          Upload a CSV to create deals. Existing file numbers are skipped;
          rows with errors are reported and not imported.
        </p>
      </div>

      {stage === "picker" && (
        <div className="space-y-6">
          <PickerView
            isDragging={isDragging}
            setIsDragging={setIsDragging}
            onDrop={onDrop}
            onPick={onPick}
            fileInputRef={fileInputRef}
            downloadSample={downloadSample}
          />
          <RecentImports refreshKey={recentRefreshKey} />
        </div>
      )}

      {stage === "preview" && (
        <PreviewView
          fileName={fileName}
          parseError={parseError}
          missingHeaders={missingHeaders}
          parsedRows={parsedRows}
          summary={summary}
          importableCount={importableRows.length}
          isImporting={isImporting}
          importError={importError}
          onCancel={reset}
          onImport={runImport}
        />
      )}

      {stage === "result" && (
        <ResultView
          results={importResults}
          onAnother={reset}
        />
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────

const PickerView: React.FC<{
  isDragging: boolean;
  setIsDragging: (v: boolean) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  downloadSample: () => void;
}> = ({ isDragging, setIsDragging, onDrop, onPick, fileInputRef, downloadSample }) => (
  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8">
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
      onClick={() => fileInputRef.current?.click()}
      className={`flex flex-col items-center justify-center gap-4 px-6 py-16 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
        isDragging
          ? "border-brand-primary bg-brand-light"
          : "border-slate-300 hover:border-brand-primary hover:bg-slate-50"
      }`}
    >
      <div className="w-16 h-16 rounded-2xl bg-brand-light flex items-center justify-center text-brand-primary">
        <Upload size={28} />
      </div>
      <div className="text-center">
        <p className="text-base font-bold text-slate-800">
          Drop your CSV here or click to browse
        </p>
        <p className="text-xs text-slate-500 mt-1">CSV files only · max 5 MB</p>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={onPick}
        className="hidden"
      />
    </div>

    <div className="mt-6 flex items-start justify-between gap-6">
      <div className="flex-1 text-xs text-slate-600 leading-relaxed">
        <p className="font-bold text-slate-700 mb-1.5 uppercase tracking-wider text-[10px]">
          Required columns
        </p>
        <p className="font-mono text-[11px] text-slate-500 leading-5">
          {REQUIRED_HEADERS.join(", ")}
        </p>
      </div>
      <button
        onClick={downloadSample}
        className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-brand-primary border border-brand-primary/30 rounded-lg hover:bg-brand-light transition-colors whitespace-nowrap"
      >
        <Download size={14} />
        Download imported data
      </button>
    </div>
  </div>
);

// ────────────────────────────────────────────────────────────────────────────

const PreviewView: React.FC<{
  fileName: string;
  parseError: string | null;
  missingHeaders: string[];
  parsedRows: ParsedRow[];
  summary: ReturnType<typeof summarize>;
  importableCount: number;
  isImporting: boolean;
  importError: string | null;
  onCancel: () => void;
  onImport: () => void;
}> = ({
  fileName,
  parseError,
  missingHeaders,
  parsedRows,
  summary,
  importableCount,
  isImporting,
  importError,
  onCancel,
  onImport,
}) => {
  const hasFatalProblem = parseError !== null || missingHeaders.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <FileText size={16} className="text-slate-400" />
          <span className="font-medium">{fileName}</span>
        </div>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-800 transition-colors"
        >
          <X size={14} />
          Cancel
        </button>
      </div>

      {parseError && (
        <BannerError title="Could not parse the file">{parseError}</BannerError>
      )}

      {missingHeaders.length > 0 && (
        <BannerError title="Missing required column(s)">
          {missingHeaders.join(", ")}. Add the missing column(s) to the CSV
          header row and re-upload.
        </BannerError>
      )}

      {!hasFatalProblem && (
        <>
          <SummaryChips summary={summary} />

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-3 w-12 text-center">#</th>
                    <th className="px-3 py-3 w-24">Status</th>
                    <th className="px-3 py-3 w-28">File #</th>
                    <th className="px-3 py-3 w-20">Type</th>
                    <th className="px-3 py-3 w-32">Clerk</th>
                    <th className="px-3 py-3 w-32">Lawyer</th>
                    <th className="px-3 py-3">Address</th>
                    <th className="px-3 py-3 w-24">Closing</th>
                    <th className="px-3 py-3 w-20">Deal status</th>
                    <th className="px-3 py-3">Issues</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {parsedRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-6 py-12 text-center text-slate-400">
                        No rows in the uploaded CSV.
                      </td>
                    </tr>
                  ) : (
                    parsedRows.map((row) => <PreviewRow key={row.index} row={row} />)
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {importError && (
            <BannerError title="Import failed">{importError}</BannerError>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={onCancel}
              disabled={isImporting}
              className="px-4 py-2 text-xs font-bold text-slate-600 hover:text-slate-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              onClick={onImport}
              disabled={importableCount === 0 || isImporting}
              className="px-5 py-2 text-xs font-bold uppercase tracking-widest text-white bg-brand-primary rounded-lg hover:bg-brand-primaryHover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isImporting
                ? "Importing…"
                : `Import ${importableCount} ${importableCount === 1 ? "row" : "rows"}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const PreviewRow: React.FC<{ row: ParsedRow }> = ({ row }) => {
  const issues = row.problems
    .map((p) => `${p.field}: ${p.message}`)
    .concat(row.skipReason ? [row.skipReason] : []);

  return (
    <tr className="hover:bg-slate-50/40">
      <td className="px-3 py-2.5 text-center text-slate-400 font-mono text-[11px]">
        {row.index}
      </td>
      <td className="px-3 py-2.5">
        <StatusChip status={row.rowStatus} />
      </td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-slate-700">
        {row.fileNumber || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-slate-700">
        {row.fileType || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-slate-700 truncate max-w-[140px]" title={row.clerk}>
        {row.clerk || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-slate-700 truncate max-w-[140px]" title={row.lawyer}>
        {row.lawyer || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-slate-700 truncate max-w-[280px]" title={row.address}>
        {row.address || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-slate-700 font-mono text-[11px]">
        {row.closingDate ?? <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-slate-700">{row.status}</td>
      <td className="px-3 py-2.5 text-slate-500 text-[11px]">
        {issues.length === 0 ? (
          <span className="text-slate-300">—</span>
        ) : (
          <ul className="space-y-0.5">
            {issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
};

// ────────────────────────────────────────────────────────────────────────────

const ResultView: React.FC<{
  results: ImportResult[];
  onAnother: () => void;
}> = ({ results, onAnother }) => {
  const created = results.filter((r) => r.outcome === "created").length;
  const updated = results.filter((r) => r.outcome === "updated").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const errored = results.filter((r) => r.outcome === "error").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <ResultChip label="Created" value={created} tone="green" />
          <ResultChip label="Updated" value={updated} tone="blue" />
          <ResultChip label="Skipped" value={skipped} tone="slate" />
          <ResultChip label="Failed" value={errored} tone="red" />
        </div>
        <button
          onClick={onAnother}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
        >
          <RotateCcw size={14} />
          Import another file
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-3 w-12 text-center">#</th>
                <th className="px-3 py-3 w-28">File #</th>
                <th className="px-3 py-3 w-24">Outcome</th>
                <th className="px-3 py-3 w-20">Type</th>
                <th className="px-3 py-3 w-20">Status</th>
                <th className="px-3 py-3">Address</th>
                <th className="px-3 py-3 w-32">Clerk</th>
                <th className="px-3 py-3 w-32">Lawyer</th>
                <th className="px-3 py-3 w-24">Closing</th>
                <th className="px-3 py-3">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {results.map((r) => (
                <tr key={r.row} className="hover:bg-slate-50/40">
                  <td className="px-3 py-2.5 text-center text-slate-400 font-mono text-[11px]">
                    {r.row}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-700">
                    {r.fileNumber}
                  </td>
                  <td className="px-3 py-2.5">
                    <OutcomeChip outcome={r.outcome} />
                  </td>
                  <td className="px-3 py-2.5 text-slate-700">
                    {r.type || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700">
                    {r.status || <span className="text-slate-300">—</span>}
                  </td>
                  <td
                    className="px-3 py-2.5 text-slate-700 truncate max-w-[280px]"
                    title={r.address ?? ""}
                  >
                    {r.address || <span className="text-slate-300">—</span>}
                  </td>
                  <td
                    className="px-3 py-2.5 text-slate-700 truncate max-w-[140px]"
                    title={r.clerk ?? ""}
                  >
                    {r.clerk || <span className="text-slate-300">—</span>}
                  </td>
                  <td
                    className="px-3 py-2.5 text-slate-700 truncate max-w-[140px]"
                    title={r.lawyer ?? ""}
                  >
                    {r.lawyer || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 font-mono text-[11px]">
                    {r.closingDate ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-600">
                    {r.reason ??
                      (r.outcome === "created"
                        ? "Deal created"
                        : r.outcome === "updated"
                          ? "Existing deal updated"
                          : "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────

const SummaryChips: React.FC<{ summary: ReturnType<typeof summarize> }> = ({ summary }) => (
  <div className="flex flex-wrap items-center gap-2">
    <Chip label="Rows" value={summary.total} tone="slate" />
    <Chip label="Ready" value={summary.ready} tone="green" />
    <Chip label="Warnings" value={summary.warnings} tone="amber" />
    <Chip label="Errors" value={summary.errors} tone="red" />
    <Chip label="Duplicates in file" value={summary.skips} tone="slate" />
  </div>
);

const Chip: React.FC<{ label: string; value: number; tone: "slate" | "green" | "amber" | "red" }> = ({
  label,
  value,
  tone,
}) => {
  const toneCls = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    green: "bg-green-100 text-green-700 border-green-200",
    amber: "bg-amber-100 text-amber-700 border-amber-200",
    red: "bg-red-100 text-red-700 border-red-200",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold border ${toneCls}`}>
      <span className="uppercase tracking-wider">{label}</span>
      <span className="font-black">{value}</span>
    </span>
  );
};

const ResultChip: React.FC<{ label: string; value: number; tone: "green" | "blue" | "slate" | "red" }> = ({
  label,
  value,
  tone,
}) => {
  const toneCls = {
    green: "bg-green-100 text-green-700 border-green-200",
    blue: "bg-blue-100 text-blue-700 border-blue-200",
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    red: "bg-red-100 text-red-700 border-red-200",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold border ${toneCls}`}>
      <span className="uppercase tracking-wider">{label}</span>
      <span className="font-black">{value}</span>
    </span>
  );
};

const StatusChip: React.FC<{ status: RowStatus }> = ({ status }) => {
  const cfg = {
    ready: { label: "Ready", cls: "bg-green-100 text-green-700 border-green-200", icon: <CheckCircle2 size={11} /> },
    warning: { label: "Warning", cls: "bg-amber-100 text-amber-700 border-amber-200", icon: <AlertTriangle size={11} /> },
    error: { label: "Error", cls: "bg-red-100 text-red-700 border-red-200", icon: <AlertCircle size={11} /> },
    skip: { label: "Skip", cls: "bg-slate-100 text-slate-600 border-slate-200", icon: <X size={11} /> },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${cfg.cls}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
};

const OutcomeChip: React.FC<{ outcome: ImportResult["outcome"] }> = ({ outcome }) => {
  const cfg = {
    created: { label: "Created", cls: "bg-green-100 text-green-700 border-green-200" },
    updated: { label: "Updated", cls: "bg-blue-100 text-blue-700 border-blue-200" },
    skipped: { label: "Skipped", cls: "bg-slate-100 text-slate-600 border-slate-200" },
    error: { label: "Error", cls: "bg-red-100 text-red-700 border-red-200" },
  }[outcome];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
};

const BannerError: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm">
    <AlertCircle size={16} className="mt-0.5 shrink-0" />
    <div>
      <p className="font-bold mb-0.5">{title}</p>
      <p className="text-xs leading-relaxed">{children}</p>
    </div>
  </div>
);

// ────────────────────────────────────────────────────────────────────────────

const RecentImports: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const [rows, setRows] = useState<RecentImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch("/api/admin/bulk-import-deals")
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || payload?.success === false) {
          setError(payload?.error ?? `Failed to load (HTTP ${res.status})`);
          setRows([]);
        } else {
          setRows(Array.isArray(payload?.deals) ? payload.deals : []);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Network error");
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50">
        <h2 className="text-sm font-bold text-slate-800">
          Recently bulk-imported deals
        </h2>
        <span className="text-[11px] text-slate-500">
          {loading ? "Loading…" : `${rows.length} ${rows.length === 1 ? "deal" : "deals"}`}
        </span>
      </div>

      {error && (
        <div className="px-5 py-3 text-xs text-red-700 bg-red-50 border-b border-red-100">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-3 w-28">File Number</th>
              <th className="px-3 py-3 w-20">File Type</th>
              <th className="px-3 py-3 w-32">File Name</th>
              <th className="px-3 py-3 w-32">Clerk</th>
              <th className="px-3 py-3 w-32">Lawyer</th>
              <th className="px-3 py-3">Address</th>
              <th className="px-3 py-3 w-24">Requisition</th>
              <th className="px-3 py-3 w-20" title="Outstanding undertakings">Out. UT</th>
              <th className="px-3 py-3 w-20" title="Outstanding requisitions">Out. RQ</th>
              <th className="px-3 py-3 w-24">Closing</th>
              <th className="px-3 py-3 w-24">Opening</th>
              <th className="px-3 py-3 w-20">Status</th>
              <th className="px-3 py-3 w-28">Imported</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={13} className="px-6 py-10 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={13} className="px-6 py-10 text-center text-slate-400">
                  No bulk imports yet. Upload a CSV above to get started.
                </td>
              </tr>
            ) : (
              rows.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50/40">
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-700">
                    {d.file_number}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700">
                    {d.type ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td
                    className="px-3 py-2.5 text-slate-700 truncate max-w-[140px]"
                    title={d.file_name ?? ""}
                  >
                    {d.file_name || <span className="text-slate-300">—</span>}
                  </td>
                  <td
                    className="px-3 py-2.5 text-slate-700 truncate max-w-[140px]"
                    title={d.clerk_name ?? ""}
                  >
                    {d.clerk_name || <span className="text-slate-300">—</span>}
                  </td>
                  <td
                    className="px-3 py-2.5 text-slate-700 truncate max-w-[140px]"
                    title={d.lawyer_name ?? ""}
                  >
                    {d.lawyer_name || <span className="text-slate-300">—</span>}
                  </td>
                  <td
                    className="px-3 py-2.5 text-slate-700 truncate max-w-[280px]"
                    title={d.property_address ?? ""}
                  >
                    {d.property_address || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 font-mono text-[11px]">
                    {d.requisition_date ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 text-center font-mono text-[11px]">
                    {d.outstanding_undertakings ?? 0}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 text-center font-mono text-[11px]">
                    {d.outstanding_requisitions ?? 0}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 font-mono text-[11px]">
                    {d.closing_date ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 font-mono text-[11px]">
                    {d.opening_date ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700">
                    {d.status ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-500 text-[11px]">
                    {new Date(d.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default BulkImport;
