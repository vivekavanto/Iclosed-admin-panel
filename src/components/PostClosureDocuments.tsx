"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Mail,
  Trash2,
  Upload,
} from "lucide-react";
import { upload } from "@vercel/blob/client";
import { BLOB_ACCESS, docDownloadHref } from "@/lib/blobPrivacy";

// Post-closure documents for a deal — the final reporting package sent to the
// client after closing.
//
// Uploads go through the shared /api/admin/uploadblobstorage endpoint with
// doc_type="final_report", so the file lands in `lead_corporate_docs` and shows
// up in the admin Documents modal and the client's portal Documents page
// without any extra plumbing.
//
// The BYTES, however, go browser -> Vercel Blob directly (the token route +
// JSON register call), never through the function. A reporting package is a
// scanned PDF and routinely clears Vercel's ~4.5 MB request-body cap; posting
// it as multipart returned a raw 413 that never reached this code, so the
// toast showed the JSON parse failure ("Unexpected token ...") instead of
// anything about the file being too big. Same shape as DepositTaskPanel.
//
// The email wording is NOT here — it comes from the "Final Reporting Package"
// row in Templates → Emails, so staff can reword it without a deploy.

const BRAND = "#C10007";

// Matches MAX_FINAL_REPORT_BYTES on the token route, which is the real
// enforcement point - Blob rejects the PUT itself. Checked here too so an
// oversized file is named as such before any bytes leave the browser.
//
// 30 MB, not the 10 MB every other document gets: a reporting package is a
// scanned bundle and 15-25 MB is normal. The email no longer carries it as an
// attachment (a download link goes out instead), so the size no longer decides
// whether the client's mail server accepts the message.
const MAX_REPORT_BYTES = 30 * 1024 * 1024;

interface FinalReportDoc {
  id: string;
  lead_id: string;
  file_name: string | null;
  file_url: string | null;
  created_at: string | null;
  emailed_at: string | null;
  emailed_to: string | null;
}

interface Recipient {
  lead_id: string;
  name: string;
  email: string | null;
  is_primary: boolean;
}

const PostClosureDocuments: React.FC<{ dealId: string }> = ({ dealId }) => {
  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<FinalReportDoc[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [primaryLeadId, setPrimaryLeadId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [emailing, setEmailing] = useState(false);
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
      const res = await fetch(`/api/admin/deals/${dealId}/final-report`);
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not load post-closure documents");
      }
      setDocuments(data.documents ?? []);
      setRecipients(data.recipients ?? []);
      setPrimaryLeadId(data.primary_lead_id ?? null);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not load post-closure documents",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpload = async (file: File) => {
    if (!primaryLeadId) {
      showToast("This file has no client record to attach the report to", "error");
      return;
    }
    if (file.size > MAX_REPORT_BYTES) {
      showToast("The final report must be 30 MB or smaller", "error");
      return;
    }

    setUploading(true);
    try {
      const pathname = `corporate-docs/${primaryLeadId}/${Date.now()}-${file.name}`;
      const blob = await upload(pathname, file, {
        access: BLOB_ACCESS,
        handleUploadUrl: "/api/admin/uploadblobstorage/token",
        contentType: file.type,
        // doc_type travels with the token request too: it is what lifts this
        // upload's ceiling to 30 MB on the token route.
        clientPayload: JSON.stringify({
          lead_id: primaryLeadId,
          doc_type: "final_report",
        }),
      });

      const res = await fetch("/api/admin/uploadblobstorage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_url: blob.url,
          file_name: file.name,
          lead_id: primaryLeadId,
          doc_type: "final_report",
        }),
      });
      // A platform-level failure (a 413, a gateway error) answers with HTML,
      // not JSON. Parsing it blind is what turned a size problem into a
      // "token" error in the toast.
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || `Upload failed (${res.status})`);
      }
      await load();
      showToast("Final report uploaded");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  };

  // Sends on the click, with no confirm step. The button names the action, the
  // recipients are listed in the panel above it, and the toast reports who
  // received it — a second dialog only added a click.
  const handleEmail = async () => {
    const withEmail = recipients.filter((r) => r.email?.trim());
    if (withEmail.length === 0) {
      showToast("No client on this file has an email address", "error");
      return;
    }

    setEmailing(true);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/final-report/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not send the final report");
      }
      await load();

      const sent = (data.sent ?? []).length;
      const failed = (data.failed ?? []).length;
      showToast(
        failed > 0
          ? `Sent to ${sent} client${sent === 1 ? "" : "s"} — ${failed} failed`
          : `Final report sent to ${sent} client${sent === 1 ? "" : "s"}`,
        failed > 0 ? "error" : "success",
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not send the final report",
        "error",
      );
    } finally {
      setEmailing(false);
    }
  };

  const handleDelete = async (doc: FinalReportDoc) => {
    if (!window.confirm(`Remove "${doc.file_name || "this document"}"?`)) return;
    try {
      const res = await fetch(
        `/api/admin/deals/${dealId}/final-report?doc_id=${doc.id}`,
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

  const hasDocuments = documents.length > 0;

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
          <h2 className="text-lg font-bold text-slate-900">Post Closure Documents</h2>
          <p className="mt-1 text-xs text-slate-500">
            The final reporting package, sent to the client(s) once the file has closed.
            PDF or image, up to 30 MB.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              // Reset first so re-picking the same file still fires a change.
              e.target.value = "";
              if (file) await handleUpload(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !primaryLeadId}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Upload size={13} />
            )}
            Upload final report
          </button>

          <button
            type="button"
            onClick={handleEmail}
            // Nothing uploaded means nothing to send — the client would get an
            // email whose download link opens an empty package.
            disabled={emailing || !hasDocuments}
            title={hasDocuments ? undefined : "Upload a final report first"}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: BRAND }}
          >
            {emailing ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Mail size={13} />
            )}
            Email to client
          </button>
        </div>
      </div>

      <div className="mt-5">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Loader2 size={15} className="animate-spin" /> Loading…
          </div>
        ) : !hasDocuments ? (
          <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center">
            <FileText size={22} className="mx-auto text-slate-300" />
            <p className="mt-2 text-sm text-slate-600">No final report uploaded yet.</p>
            <p className="mt-1 text-xs text-slate-400">
              Upload the reporting package to send it to the client(s).
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
                <FileText size={16} className="shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {doc.file_name || "Final report"}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
                    {doc.created_at && <span>Uploaded {doc.created_at.slice(0, 10)}</span>}
                    {doc.emailed_at && (
                      <span className="inline-flex items-center gap-1 text-green-600">
                        <CheckCircle2 size={11} />
                        Sent {doc.emailed_at.slice(0, 10)}
                        {doc.emailed_to ? ` to ${doc.emailed_to}` : ""}
                      </span>
                    )}
                  </p>
                </div>
                {doc.file_url && (
                  <a
                    href={docDownloadHref(doc.file_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    <Download size={12} /> Open
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(doc)}
                  aria-label="Remove document"
                  className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-slate-50 hover:text-red-600"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {hasDocuments && recipients.length > 0 && (
        <p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-400">
          Sends to{" "}
          {recipients
            .filter((r) => r.email?.trim())
            .map((r) => r.name || r.email)
            .join(", ") || "nobody — no email addresses on file"}
          . Each client gets their own copy, addressed to them, carrying a secure
          download link rather than an attachment &mdash; so the package size can never
          bounce the email. The link works for 180 days; the documents stay in the
          client&rsquo;s portal permanently. Wording comes from the &ldquo;Final Reporting
          Package&rdquo; email template.
        </p>
      )}
    </div>
  );
};

export default PostClosureDocuments;
