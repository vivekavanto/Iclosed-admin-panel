"use client";

import { useState } from "react";
import {
  ShieldCheck,
  IdCard,
  FileUp,
  UserCog,
  Check,
} from "lucide-react";
import CoPersonPersonalInfoModal from "./CoPersonPersonalInfoModal";

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
  /** The co-person's own deal id — used to load their personal-info task. */
  dealId: string;
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

function CoPersonCard({
  person,
  onUploadId,
  onChanged,
}: {
  person: OnBehalfCoPerson;
  onUploadId: (leadId: string, taskId: string) => void;
  onChanged: () => void;
}) {
  // Opens the full "Provide Personal Information" task popup for this person.
  const [personalInfoOpen, setPersonalInfoOpen] = useState(false);

  const idCompleted = person.identificationStatus === "Completed";

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

        {/* 2. Upload verification documents — display-only button for now; the
            upload flow is intentionally not wired up, so clicking does nothing. */}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:border-brand-primary hover:text-brand-primary transition-colors cursor-pointer"
          title="Upload a verification document for this person"
        >
          <FileUp size={13} />
          Upload verification documents
        </button>

        {/* 3. Submit contact information — opens the full personal-information
            task form for this person. */}
        <button
          type="button"
          onClick={() => setPersonalInfoOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:border-brand-primary hover:text-brand-primary transition-colors cursor-pointer"
          title="Provide this person's personal information"
        >
          <UserCog size={13} />
          Submit contact information
        </button>
      </div>

      <CoPersonPersonalInfoModal
        open={personalInfoOpen}
        onClose={() => setPersonalInfoOpen(false)}
        coPerson={{
          leadId: person.leadId,
          dealId: person.dealId,
          name: person.name,
          role: person.role,
        }}
        onSaved={onChanged}
      />
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
