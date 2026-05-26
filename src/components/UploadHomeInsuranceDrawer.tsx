"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Upload, FileText, Trash2, AlertCircle, CheckCircle2 } from "lucide-react";
import Button from "@/components/ui/Button";
import { useIsLargeScreen } from "@/hooks/useMediaQuery";

interface UploadHomeInsuranceDrawerProps {
  open: boolean;
  onClose: () => void;
  leadId?: string;
  taskId?: string;
 
  existingResponseId?: string | null;
  
  fieldId?: string | null;
  fieldLabel?: string | null;
  onSaved?: () => void;
}

const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx"];
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function validateFile(f: File): string | null {
  const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) return "Only PDF, DOC, and DOCX files are allowed.";
  if (f.size > MAX_SIZE) return "File size must not exceed 10 MB.";
  return null;
}

const POLICY_CHECKLIST = [
  "Policy effective date matches or precedes closing date",
  "Coverage amount meets lender requirements",
  "Property address matches purchase agreement",
  "Lender listed as mortgagee (if applicable)",
];

const CONDO_RECOMMENDATIONS = [
  {
    title: "Unit Coverage:",
    desc: "Covers improvements, fixtures, and personal property within your unit",
  },
  {
    title: "Contents Insurance:",
    desc: "Protects your personal belongings and furniture",
  },
  {
    title: "Loss Assessment Coverage:",
    desc: "Covers special assessments from the condo corporation",
  },
  {
    title: "Additional Living Expenses:",
    desc: "Covers temporary accommodation if your unit becomes uninhabitable",
  },
];

export default function UploadHomeInsuranceDrawer({
  open,
  onClose,
  leadId,
  taskId,
  existingResponseId,
  fieldId,
  fieldLabel,
  onSaved,
}: UploadHomeInsuranceDrawerProps) {
  const isLargeScreen = useIsLargeScreen();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClose = useCallback(() => {
    setFile(null);
    setError(null);
    setUploaded(false);
    setIsDragging(false);
    onClose();
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) handleClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [open, handleClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  function handlePickFile(f: File) {
    const err = validateFile(f);
    if (err) { setError(err); setFile(null); return; }
    setError(null);
    setFile(f);
    setUploaded(false);
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handlePickFile(f);
  }, []);

  function handleDelete() {
    setFile(null);
    setError(null);
    setUploaded(false);
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("lead_id", leadId ?? "unknown");
      fd.append("doc_type", "home_insurance");
      const res = await fetch("/api/admin/uploadblobstorage", { method: "POST", body: fd });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? "Upload failed");

      const fileUrl: string | undefined = data.url ?? data.file_url;
      if (!fileUrl) throw new Error("Upload did not return a URL.");

      // If we have a taskId, record the response in the DB so the task is marked done.
      // Admin endpoint takes a single response per request (not a batch).
      if (taskId) {
        // If admin is replacing an existing file, delete the previous response
        // row first so we don't accumulate duplicates.
        if (existingResponseId) {
          await fetch(
            `/api/admin/task-responses?id=${encodeURIComponent(existingResponseId)}`,
            { method: "DELETE" },
          );
        }

        const respRes = await fetch("/api/admin/task-responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task_id: taskId,
            field_id: fieldId ?? null,
            field_label: fieldLabel || "Home Insurance Policy",
            field_type: "file",
            file_url: fileUrl,
            file_name: file.name,
          }),
        });
        if (!respRes.ok) throw new Error("File uploaded, but failed to record response.");

        if (onSaved) onSaved();
      }

      setUploaded(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={[
          "fixed inset-0 z-40 transition-opacity duration-300",
          isLargeScreen ? "bg-black/40 backdrop-blur-sm" : "bg-black/30",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Modal (large screens) / Drawer (mobile) */}
      <div
        className={[
          "fixed z-50 bg-white shadow-2xl flex flex-col",
          isLargeScreen
            ? "inset-4 sm:inset-8 md:inset-12 lg:inset-16 xl:inset-20 max-w-5xl max-h-[90vh] mx-auto my-auto rounded-2xl border border-gray-100"
            : "top-0 right-0 h-full w-full max-w-[500px]",
          isLargeScreen
            ? open
              ? "opacity-100 scale-100"
              : "opacity-0 scale-95 pointer-events-none"
            : open
              ? "translate-x-0"
              : "translate-x-full",
          isLargeScreen
            ? "transition-all duration-200 ease-out"
            : "transition-transform duration-300 ease-in-out",
        ].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label="Home Insurance Policy"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
          <div className="flex items-start gap-2.5 flex-1 min-w-0 pr-4">
            <div className="flex-shrink-0 mt-0.5 w-5 h-5 rounded-full bg-[#C10007] flex items-center justify-center">
              <AlertCircle size={12} className="text-white" strokeWidth={2.5} />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900 leading-snug">
                Home Insurance Policy
              </h2>
              <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                Upload your home insurance policy and learn about coverage requirements.
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="cursor-pointer flex-shrink-0 rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* Policy Requirements Checklist */}
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="text-sm font-bold text-gray-900 mb-3">
              Policy Requirements Checklist
            </h3>
            <ul className="space-y-2">
              {POLICY_CHECKLIST.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="flex-shrink-0 mt-[7px] w-1.5 h-1.5 rounded-full bg-gray-800" />
                  <span className="text-xs text-gray-600 leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Condominium Insurance Recommendations */}
          <div>
            <h3 className="text-sm font-bold text-gray-900 mb-1">
              Condominium Insurance Recommendations
            </h3>
            <p className="text-xs text-gray-500 mb-3 leading-relaxed">
              For condominium purchases, consider these additional coverage options:
            </p>
            <ul className="space-y-3">
              {CONDO_RECOMMENDATIONS.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="flex-shrink-0 mt-[7px] w-1.5 h-1.5 rounded-full bg-[#C10007]" />
                  <p className="text-xs text-gray-600 leading-relaxed">
                    <span className="font-semibold text-gray-800">{item.title}</span>{" "}
                    {item.desc}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {/* Upload Section */}
          <div>
            <h3 className="text-sm font-bold text-gray-900 mb-3">
              Upload Your Home Insurance Policy
            </h3>

            {/* Drop zone — shown when no file selected */}
            {!file && (
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={[
                  "rounded-xl border-2 border-dashed transition-all duration-200",
                  isDragging
                    ? "border-[#C10007] bg-[#FEF2F2]"
                    : "border-gray-200 bg-white",
                ].join(" ")}
              >
                <div className="flex flex-col items-center justify-center gap-3 py-10 px-6 text-center">
                  <div className={[
                    "w-10 h-10 rounded-full flex items-center justify-center transition-colors",
                    isDragging ? "bg-[#FEF2F2]" : "bg-gray-100",
                  ].join(" ")}>
                    <Upload
                      size={18}
                      className={isDragging ? "text-[#C10007]" : "text-gray-400"}
                      strokeWidth={2}
                    />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      Click to upload or drag and drop
                    </p>
                    <p className="text-xs text-gray-400 mt-1">PDF, DOC, DOCX up to 10MB</p>
                  </div>
                  <button
                    onClick={() => inputRef.current?.click()}
                    className="cursor-pointer mt-1 px-5 py-2 text-xs font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-colors"
                  >
                    Choose File
                  </button>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".pdf,.doc,.docx"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handlePickFile(f);
                    e.target.value = "";
                  }}
                />
              </div>
            )}

            {/* File card — shown after file is chosen */}
            {file && (
              <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3.5">
                <div className="w-10 h-10 rounded-lg bg-[#FEF2F2] flex items-center justify-center flex-shrink-0">
                  <FileText size={17} className="text-[#C10007]" strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{file.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{formatBytes(file.size)}</p>
                </div>
                {uploaded && (
                  <CheckCircle2 size={17} className="text-green-500 flex-shrink-0" strokeWidth={2} />
                )}
                <button
                  onClick={handleDelete}
                  className="cursor-pointer flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-400 hover:text-[#C10007] hover:border-red-200 hover:bg-red-50 transition-colors"
                  title="Remove"
                  aria-label="Remove file"
                >
                  <Trash2 size={14} strokeWidth={2} />
                </button>
              </div>
            )}

            {/* Validation / upload error */}
            {error && (
              <div className="flex items-center gap-2 mt-2.5 text-xs text-[#C10007]">
                <AlertCircle size={13} strokeWidth={2} className="flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex flex-col-reverse sm:flex-row gap-3">
          <Button
            variant="secondary"
            fullWidth
            onClick={handleClose}
            disabled={uploading}
            className="sm:flex-1"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            fullWidth
            disabled={!file || uploading || uploaded}
            loading={uploading}
            onClick={handleUpload}
            className="sm:flex-1"
          >
            {uploaded ? "Policy Uploaded" : "Upload Policy"}
          </Button>
        </div>
      </div>
    </>
  );
}
