"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  FileText,
  Inbox,
  Loader2,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { upload } from "@vercel/blob/client";
import { BLOB_ACCESS, docDownloadHref } from "@/lib/blobPrivacy";
import { openDocForViewing } from "@/lib/docViewer";
import { formatFileSize } from "@/lib/uploadValidation";

// Free-form, multi-file drop zone for documents that don't fit an existing
// type. Same plumbing as PostClosureDocuments: doc_type="other" on
// lead_corporate_docs, direct-to-Blob upload, filed against the family's
// primary lead.
const OTHER_DOC_TYPE = "other";

// Matches LARGE_DOC_TYPES("other") in uploadValidation.ts, the real cap.
const MAX_OTHER_BYTES = 30 * 1024 * 1024;
const ACCEPT =
  "application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";

interface OtherDoc {
  id: string;
  lead_id: string;
  file_name: string | null;
  file_url: string | null;
  file_size: number | null;
  custom_type: string | null;
  created_at: string | null;
}

function formatUploadedDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const OtherDocuments: React.FC<{ dealId: string }> = ({ dealId }) => {
  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<OtherDoc[]>([]);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [dragActive, setDragActive] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/other-documents`);
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not load Other Documents");
      }
      setDocuments(data.documents ?? []);
      setLeadId(data.lead_id ?? null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not load Other Documents", "error");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  const uploadOne = async (file: File): Promise<{ ok: boolean; name: string; error?: string }> => {
    if (file.size > MAX_OTHER_BYTES) {
      return { ok: false, name: file.name, error: "must be 30 MB or smaller" };
    }
    try {
      const pathname = `corporate-docs/${leadId}/${Date.now()}-${file.name}`;
      const blob = await upload(pathname, file, {
        access: BLOB_ACCESS,
        handleUploadUrl: "/api/admin/uploadblobstorage/token",
        contentType: file.type,
        clientPayload: JSON.stringify({ lead_id: leadId, doc_type: OTHER_DOC_TYPE }),
      });

      const res = await fetch("/api/admin/uploadblobstorage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_url: blob.url,
          file_name: file.name,
          lead_id: leadId,
          doc_type: OTHER_DOC_TYPE,
        }),
      });
      // A platform-level failure answers with HTML, not JSON.
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || `Upload failed (${res.status})`);
      }
      return { ok: true, name: file.name };
    } catch (err) {
      return { ok: false, name: file.name, error: err instanceof Error ? err.message : "failed" };
    }
  };

  const handleFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    if (!leadId) {
      showToast("This file has no client record to attach documents to", "error");
      return;
    }

    setUploadProgress({ done: 0, total: files.length });
    const failures: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const result = await uploadOne(files[i]);
      if (!result.ok) failures.push(`${result.name} (${result.error})`);
      setUploadProgress({ done: i + 1, total: files.length });
    }
    setUploadProgress(null);
    await load();

    const succeeded = files.length - failures.length;
    if (failures.length === 0) {
      showToast(`Uploaded ${succeeded} document${succeeded === 1 ? "" : "s"}`);
    } else {
      showToast(
        succeeded > 0
          ? `Uploaded ${succeeded}, but ${failures.length} failed: ${failures.join(", ")}`
          : `Upload failed: ${failures.join(", ")}`,
        "error",
      );
    }
  };

  const startRename = (doc: OtherDoc) => {
    setEditingId(doc.id);
    setEditValue(doc.custom_type || doc.file_name || "");
  };

  const saveRename = async (doc: OtherDoc) => {
    const label = editValue.trim();
    setEditingId(null);
    if (label === (doc.custom_type || "")) return;
    setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, custom_type: label } : d)));
    try {
      const res = await fetch(
        `/api/admin/deals/${dealId}/other-documents?doc_id=${doc.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        },
      );
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error || "Could not rename");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not rename", "error");
      await load();
    }
  };

  const handleDelete = async (doc: OtherDoc) => {
    if (!window.confirm(`Remove "${doc.custom_type || doc.file_name || "this document"}"?`)) {
      return;
    }
    try {
      const res = await fetch(
        `/api/admin/deals/${dealId}/other-documents?doc_id=${doc.id}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error || "Could not remove");
      await load();
      showToast("Document removed");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not remove", "error");
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
      {toast && (
        <div
          role="status"
          className={`fixed right-6 top-6 z-50 rounded-lg px-4 py-3 text-sm text-white shadow-lg ${
            toast.type === "error" ? "bg-red-600" : "bg-gray-900"
          }`}
        >
          {toast.message}
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Other Documents</h2>
          <p className="mt-1 text-xs text-slate-500">
            Anything else related to this file — drop it here. Label files to keep them
            easy to find. PDF, image, or Office files, up to 30 MB each.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={async (e) => {
            // Snapshot before resetting value — clearing it empties the live FileList too.
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 0) await handleFiles(files);
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!!uploadProgress || !leadId}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {uploadProgress ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Upload size={13} />
          )}
          Upload Documents
        </button>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragActive(false);
          if (e.dataTransfer.files?.length) await handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragActive ? "border-slate-400 bg-slate-50" : "border-slate-200 hover:bg-slate-50/50"
        }`}
      >
        {uploadProgress ? (
          <>
            <Loader2 size={22} className="animate-spin text-slate-400" />
            <p className="mt-2 text-sm font-semibold text-slate-700">
              Uploading {uploadProgress.done} of {uploadProgress.total}…
            </p>
          </>
        ) : (
          <>
            <Inbox size={22} className="text-slate-300" />
            <p className="mt-2 text-sm font-semibold text-slate-700">
              Drag files here, or click to browse
            </p>
            <p className="mt-1 text-xs text-slate-400">You can select multiple files at once</p>
          </>
        )}
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
            <Loader2 size={15} className="animate-spin" /> Loading…
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {documents.map((doc) => {
              const label = doc.custom_type || doc.file_name || "Document";
              const isEditing = editingId === doc.id;
              return (
                <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
                    <FileText size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => saveRename(doc)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="w-full max-w-xs rounded border border-slate-300 px-2 py-1 text-sm font-semibold text-slate-800 focus:border-slate-400 focus:outline-none"
                      />
                    ) : (
                      <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-800">
                        {label}
                        <button
                          type="button"
                          onClick={() => startRename(doc)}
                          aria-label="Rename document"
                          className="text-slate-300 hover:text-slate-500"
                        >
                          <Pencil size={12} />
                        </button>
                      </p>
                    )}
                    <p className="mt-0.5 truncate text-[11px] text-slate-400">
                      {doc.file_name} · {formatFileSize(doc.file_size)} · Uploaded{" "}
                      {formatUploadedDate(doc.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void openDocForViewing(doc)}
                      aria-label="View document"
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                    >
                      <Eye size={14} />
                    </button>
                    {doc.file_url && (
                      <a
                        href={docDownloadHref(doc.file_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Download document"
                        className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                      >
                        <Download size={14} />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDelete(doc)}
                      aria-label="Remove document"
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-slate-50 hover:text-red-600"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default OtherDocuments;
