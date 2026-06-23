"use client";

import { useRef, useState } from "react";
import {
  ShieldCheck,
  IdCard,
  FileUp,
  UserCog,
  Check,
  Loader2,
  CheckCircle2,
} from "lucide-react";

/**
 * "Submit on behalf of co-purchaser(s)/co-seller(s)" section.
 *
 * Rendered on the PRIMARY applicant's deal view ONLY when the primary opted in
 * (leads.submit_on_behalf === true, set from the client portal's post-retainer
 * popup). When the primary did not grant access, the parent renders nothing —
 * so there is simply no section, matching "no access → no section needed".
 *
 * Per co-person it offers the three things the client-portal popup promised:
 *   1. Upload their ID      — reuses the parent's UploadIdentificationDrawer
 *                             via onUploadId(leadId, taskId).
 *   2. Upload verification documents — POSTs to /api/admin/uploadblobstorage
 *                             (blob + lead_corporate_docs row) as doc_type
 *                             "document".
 *   3. Submit contact information — PUTs first/last/email/phone to
 *                             /api/admin/leads.
 */

export interface OnBehalfCoPerson {
  leadId: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  identificationTaskId: string | null;
  identificationStatus: string | null;
}

interface Props {
  coPersons: OnBehalfCoPerson[];
  /** Opens the existing identification drawer for a given co-person. */
  onUploadId: (leadId: string, taskId: string) => void;
  /** Called after a successful document/contact change so the parent can refresh. */
  onChanged: () => void;
}

const DOC_ACCEPT = ".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp";
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function CoPersonCard({
  person,
  onUploadId,
  onChanged,
}: {
  person: OnBehalfCoPerson;
  onUploadId: (leadId: string, taskId: string) => void;
  onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [docDone, setDocDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = splitName(person.name);
  const [editingContact, setEditingContact] = useState(false);
  const [firstName, setFirstName] = useState(initial.first);
  const [lastName, setLastName] = useState(initial.last);
  const [email, setEmail] = useState(person.email);
  const [phone, setPhone] = useState(person.phone);
  const [savingContact, setSavingContact] = useState(false);
  const [contactDone, setContactDone] = useState(false);

  const idCompleted = person.identificationStatus === "Completed";

  async function handleDocFile(file: File) {
    setError(null);
    if (file.size > MAX_SIZE) {
      setError("File size must not exceed 10 MB.");
      return;
    }
    setUploadingDoc(true);
    setDocDone(false);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("lead_id", person.leadId);
      fd.append("doc_type", "document");
      fd.append("custom_type", "Verification Document");
      const res = await fetch("/api/admin/uploadblobstorage", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Upload failed");
      }
      setDocDone(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploadingDoc(false);
    }
  }

  async function handleSaveContact() {
    setError(null);
    setSavingContact(true);
    setContactDone(false);
    try {
      const res = await fetch("/api/admin/leads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: person.leadId,
          firstName,
          lastName,
          email,
          phone,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Could not save contact information");
      }
      setContactDone(true);
      setEditingContact(false);
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save contact information",
      );
    } finally {
      setSavingContact(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold border bg-blue-100 text-blue-700 border-blue-200">
          {person.role}
        </span>
        <p className="text-sm font-bold text-slate-800">{person.name}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* 1. Upload their ID */}
        <button
          type="button"
          disabled={!person.identificationTaskId}
          onClick={() =>
            person.identificationTaskId &&
            onUploadId(person.leadId, person.identificationTaskId)
          }
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:border-brand-primary hover:text-brand-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          title={
            person.identificationTaskId
              ? "Upload this person's identification"
              : "No identification task found for this person yet"
          }
        >
          <IdCard size={13} />
          Upload their ID
          {idCompleted && <Check size={13} className="text-green-600" />}
        </button>

        {/* 2. Upload verification documents */}
        <button
          type="button"
          disabled={uploadingDoc}
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:border-brand-primary hover:text-brand-primary transition-colors disabled:opacity-50 cursor-pointer"
          title="Upload a verification document for this person"
        >
          {uploadingDoc ? (
            <Loader2 size={13} className="animate-spin" />
          ) : docDone ? (
            <CheckCircle2 size={13} className="text-green-600" />
          ) : (
            <FileUp size={13} />
          )}
          {docDone ? "Document uploaded" : "Upload verification documents"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={DOC_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleDocFile(f);
            e.target.value = "";
          }}
        />

        {/* 3. Submit contact information */}
        <button
          type="button"
          onClick={() => setEditingContact((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:border-brand-primary hover:text-brand-primary transition-colors cursor-pointer"
          title="Edit this person's contact information"
        >
          <UserCog size={13} />
          Submit contact information
          {contactDone && <Check size={13} className="text-green-600" />}
        </button>
      </div>

      {editingContact && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5 rounded-lg border border-slate-200 bg-white p-3">
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-slate-500">
            First name
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="text-sm border border-slate-300 rounded px-2 py-1.5 font-normal text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-slate-500">
            Last name
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="text-sm border border-slate-300 rounded px-2 py-1.5 font-normal text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-slate-500">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="text-sm border border-slate-300 rounded px-2 py-1.5 font-normal text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-slate-500">
            Phone
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="text-sm border border-slate-300 rounded px-2 py-1.5 font-normal text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-primary"
            />
          </label>
          <div className="sm:col-span-2 flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setEditingContact(false)}
              disabled={savingContact}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveContact}
              disabled={savingContact}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-primary text-white hover:bg-[#a30006] disabled:opacity-50 cursor-pointer"
            >
              {savingContact && <Loader2 size={13} className="animate-spin" />}
              Save contact
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-[#C10007]">{error}</p>}
    </div>
  );
}

export default function SubmitOnBehalfSection({
  coPersons,
  onUploadId,
  onChanged,
}: Props) {
  if (coPersons.length === 0) return null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-green-200 p-5 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-7 h-7 rounded-full bg-green-50 border border-green-100 flex items-center justify-center text-green-600 flex-shrink-0">
          <ShieldCheck size={14} />
        </div>
        <h3 className="text-sm font-bold text-slate-900">
          Submit on behalf of co-purchaser(s) / co-seller(s)
        </h3>
      </div>
      <p className="text-[11px] text-slate-400 mb-3 ml-9">
        The primary applicant authorized uploading documents and ID for the
        people below. They&apos;ll still sign their own retainer.
      </p>
      <div className="space-y-3">
        {coPersons.map((p) => (
          <CoPersonCard
            key={p.leadId}
            person={p}
            onUploadId={onUploadId}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}
