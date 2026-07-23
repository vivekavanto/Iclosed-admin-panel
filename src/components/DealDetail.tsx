"use client";

import React, { useState, useRef, useEffect } from "react";
import { Deal, Task, Milestone, DealStatus } from "../types";
import {
  ArrowLeft,
  Calendar,
  User,
  Building2,
  Trash2,
  Plus,
  Mail,
  Phone,
  CheckCircle,
  GripVertical,
  FileText,
  Pencil,
  Eye,
  Download,
  FileDown,
  Loader2,
  Copy,
  ExternalLink,
  AlertTriangle,
  Info,
  Upload,
  Check,
  X,
  UserPlus,
  LogIn,
  FileSignature,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  isNonCitizenFlagged,
  NON_CITIZEN_FLAG_TOOLTIP,
} from "@/lib/isNonCitizenFlagged";
import { formatLocalDate, formatLocalDateTime } from "@/lib/formatDate";
import {
  downloadTaskPdf,
  downloadDealPdf,
  type PdfDealMeta,
  type PdfTaskInput,
  type PdfDealSection,
} from "@/lib/dealPdf";
import { upload } from "@vercel/blob/client";
import {
  BLOB_ACCESS,
  docDownloadHref,
  docFetchCredentials,
} from "@/lib/blobPrivacy";
import UploadIdentificationDrawer from "./UploadIdentificationDrawer";
import UploadHomeInsuranceDrawer from "./UploadHomeInsuranceDrawer";
import SubmitOnBehalfSection, { OnBehalfCoPerson } from "./SubmitOnBehalfSection";
import CoPersonPersonalInfoModal from "./CoPersonPersonalInfoModal";
import ClonePreviousDealDrawer from "./ClonePreviousDealDrawer";
import EditDealModal from "./EditDealModal";
import AddCoClientModal from "./AddCoClientModal";

interface DealDetailProps {
  deal: Deal;
  rawDeal?: Record<string, any> | null;
  /** Re-fetch the deal row from the server. Needed after an edit that writes
   *  to a table `rawDeal` only JOINs (the client's name lives on `leads`), so
   *  the page's mount-time snapshot would otherwise stay stale. */
  onDealChanged?: () => void | Promise<void>;
  onBack?: () => void;
}

const IdentificationChip: React.FC<{ meta: any }> = ({ meta }) => {
  if (!meta || meta.doc_type !== 'identification') return null;

  if (meta.is_identification === false) {
    return (
      <span
        className="inline-flex self-start items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 border border-red-200 mt-1"
        title={meta.detection_reason || 'Gemini could not classify this as an ID document'}
      >
        <AlertTriangle size={10} />
        Not a recognized ID
      </span>
    );
  }

  if (!meta.document_type) return null;

  const label = meta.side && meta.side !== 'unknown'
    ? `${meta.document_type} (${meta.side})`
    : meta.document_type;
  const isLowConf = meta.confidence && meta.confidence !== 'high';
  const expectedSide =
    meta.custom_type === 'primary_back' || meta.custom_type === 'secondary_back' ? 'back'
    : meta.custom_type === 'primary_front' || meta.custom_type === 'secondary_front' ? 'front'
    : null;
  const sideMismatch = expectedSide && meta.side && meta.side !== 'unknown' && meta.side !== expectedSide;

  return (
    <span
      className={`inline-flex self-start items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border mt-1 ${isLowConf ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}
      title={meta.detection_reason || undefined}
    >
      {label}
      {isLowConf && <span className="font-normal text-slate-400">· low confidence</span>}
      {sideMismatch && <AlertTriangle size={10} className="text-amber-500" />}
    </span>
  );
};

const DealDetail: React.FC<DealDetailProps> = ({ deal, rawDeal, onDealChanged, onBack }) => {
  const router = useRouter();
  const handleBack = onBack || (() => router.push("/admin/deals"));

  const mapApiTask = (t: any): Task => ({
    id: t.id,
    title: t.title,
    completed: t.completed ?? false,
    status: t.status,
    dueDate: t.due_date ?? t.dueDate,
    assignee: t.assignee,
    completedAt: t.completed_at ?? t.completedAt,
    document: t.document_name ? { name: t.document_name, url: t.document_url ?? '#' } : undefined,
    milestoneId: t.milestone_id ?? undefined,
    isShared: t.is_shared ?? false,
    taskTemplateId: t.task_template_id ?? null,
    leadType: t.task_templates?.lead_type ?? null,
    orderIndex: t.order_index ?? null,
    ownerDealId: t.owner_deal_id ?? null,
    ownerLeadId: t.owner_lead_id ?? null,
    ownerName: t.owner_name ?? null,
    ownerFirstName: t.owner_first_name ?? null,
    ownerLastName: t.owner_last_name ?? null,
    ownerPhone: t.owner_phone ?? null,
  });

  // Use state to allow modification simulation
  const [tasks, setTasks] = useState<Task[]>(deal.tasks || []);
  const [milestones, setMilestones] = useState<Milestone[]>(
    deal.milestones || [],
  );

  // Narrow combined "Purchase & Sale" deals down to the single side that
  // actually applies to a co-purchaser/co-seller. Their deal still inherits
  // the parent's combined type, but they should only see one workflow.
  const deriveDealTypeParts = (
    dealType: string | null | undefined,
    coRole?: string | null,
  ): string[] => {
    const raw = (dealType ?? "")
      .split(/\s*(?:&|\band\b|\+|\/)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);
    if (coRole === "Co-Purchaser") {
      const narrowed = raw.filter((p) => p.toLowerCase() === "purchase");
      return narrowed.length > 0 ? narrowed : raw;
    }
    if (coRole === "Co-Seller") {
      const narrowed = raw.filter((p) => p.toLowerCase() === "sale");
      return narrowed.length > 0 ? narrowed : raw;
    }
    return raw;
  };

  // Unified family view: on the PRIMARY deal that has co-purchasers/co-sellers,
  // the tasks fetch aggregates every person's ID & Personal Information rows
  // (include_family=1) so they show in one list labeled by name. Co-person
  // pages and single-person deals keep the original single-deal scope, leaving
  // the customer portal and direct co-person views byte-for-byte unchanged.
  const isPrimaryDealView =
    ((rawDeal?.current_deal_role as string | undefined) ?? "")
      .toLowerCase()
      .startsWith("primary") || !rawDeal?.current_deal_role;
  const familyMemberCount = 1 + ((rawDeal?.linked_deals as any[]) ?? []).length;
  const includeFamilyTasks = isPrimaryDealView && familyMemberCount > 1;
  const tasksFetchUrl = `/api/admin/tasks?deal_id=${deal.id}${includeFamilyTasks ? "&include_family=1" : ""}`;

  // For combined deals (e.g. "Purchase & Sale"), tasks, milestones, and the
  // displayed property address all share a single active-workflow tab so
  // switching one section moves them all together.
  const [activeWorkflowTab, setActiveWorkflowTab] = useState<string>(() => {
    const parts = deriveDealTypeParts(deal.type, rawDeal?.current_deal_role);
    return parts[0] ?? "";
  });
  // Aliases keep existing usages working while we migrate to the unified state.
  const activeTaskTab = activeWorkflowTab;
  const activeMilestoneTab = activeWorkflowTab;
  const setActiveTaskTab = setActiveWorkflowTab;
  const setActiveMilestoneTab = setActiveWorkflowTab;

  // Extended display types with template flag and resolved lead-type (for combined deals)
  type DisplayTask = Task & { isTemplate?: boolean; leadType?: string | null };
  type DisplayMilestone = Milestone & {
    isTemplate?: boolean;
    leadType?: string | null;
    // Legacy per-person split flag (no longer produced — personal-task stages
    // now collapse to a single aggregate row, see personalProgress).
    isPersonalSplit?: boolean;
    // Set on the single row for a personal-task stage (Personal Information /
    // Identification) in the family view. Carries the aggregate "X of N people
    // done" so the row shows a "X/N completed" badge and a derived Pending/
    // Completed status instead of splitting into one row per person.
    personalProgress?: { completed: number; total: number } | null;
  };

  // View task detail modal
  const [viewingTask, setViewingTask] = useState<DisplayTask | null>(null);
  const [viewTaskResponses, setViewTaskResponses] = useState<any[]>([]);
  const [loadingTaskResponses, setLoadingTaskResponses] = useState(false);

  const openTaskView = async (task: DisplayTask) => {
    setViewingTask(task);
    setViewTaskResponses([]);
    if (task.isTemplate) return;
    setLoadingTaskResponses(true);
    try {
      const res = await fetch(`/api/admin/task-responses?task_id=${task.id}`);
      const data = await res.json();
      if (Array.isArray(data)) setViewTaskResponses(data);
    } catch { }
    setLoadingTaskResponses(false);
  };

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Inline lock box code editor (its own card under Milestones, Purchase files only).
  // Held in local state so a save reflects immediately — refetchData() only
  // refreshes tasks/milestones, not the server-rendered deal prop — and
  // router.refresh() re-syncs the source row afterward.
  const initialLockbox = (rawDeal?.lockbox_code as string | null | undefined) ?? "";
  const [lockboxValue, setLockboxValue] = useState<string>(initialLockbox);
  const [lockboxDraft, setLockboxDraft] = useState<string>(initialLockbox);
  const [savingLockbox, setSavingLockbox] = useState(false);
  useEffect(() => {
    const v = (rawDeal?.lockbox_code as string | null | undefined) ?? "";
    setLockboxValue(v);
    setLockboxDraft(v);
  }, [rawDeal?.lockbox_code]);
  const saveLockboxCode = async () => {
    const next = lockboxDraft.trim();
    if (next === (lockboxValue ?? "").trim()) return;
    setSavingLockbox(true);
    try {
      const res = await fetch(`/api/admin/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockbox_code: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to save lock box code");
      setLockboxValue(next);
      showToast("Lock box code saved");
      router.refresh();
    } catch (err: any) {
      showToast(err?.message ?? "Failed to save lock box code", "error");
    } finally {
      setSavingLockbox(false);
    }
  };

  // Documents modal state
  const [showDocuments, setShowDocuments] = useState(false);
  const [dealDocuments, setDealDocuments] = useState<{ task_id: string; file_name: string; file_url: string; task_title: string }[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);

  // Edit deal modal — opens the existing EditDealModal so closing/opening/
  // requisition dates and lawyer/clerk names can be updated from the header.
  const [showEditDeal, setShowEditDeal] = useState(false);

  // Add co-purchaser / co-seller modal — admins use this to attach a co-client
  // to an already-created deal (the customer portal does the same at intake).
  const [showAddCoClient, setShowAddCoClient] = useState(false);

  // Inline phone editing in "People involved". Each person's phone lives on
  // their lead row; edits PUT to /api/admin/leads. `phoneOverrides` (keyed by
  // lead_id) holds successfully-saved values so the displayed number updates
  // without refetching the whole deal — it's read inside familyPeople below.
  const [phoneOverrides, setPhoneOverrides] = useState<Record<string, string>>({});
  const [editingPhoneLeadId, setEditingPhoneLeadId] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState<string>("");
  const [savingPhoneId, setSavingPhoneId] = useState<string | null>(null);

  // APS upload modal state — multiple files can be uploaded at once and they
  // APPEND to any existing APS docs (agreement + amendments/waivers).
  const [showApsUpload, setShowApsUpload] = useState(false);
  const [apsFiles, setApsFiles] = useState<File[]>([]);
  const [uploadingAps, setUploadingAps] = useState(false);
  // Which side this APS upload targets. Set explicitly when the modal is
  // opened from the header (so a Purchase & Sale deal can upload a Purchase
  // APS and a Sale APS separately). Left null when opened from an APS task's
  // Edit modal — there the side is derived from the task's template lead_type.
  const [apsUploadSide, setApsUploadSide] = useState<"purchase" | "sale" | null>(null);
  // Preflight: how many APS docs already exist for this deal's family. Used to
  // show an informational "N already uploaded — new files will be added" note.
  const [existingApsCount, setExistingApsCount] = useState<number>(0);
  const [apsStatusLoading, setApsStatusLoading] = useState(false);

  // Full task edit modal — Pencil button on a task row opens this, mirroring
  // the View modal's layout but with editable inputs. Saves are batched:
  // task fields go through one PATCH /api/admin/tasks; client-response
  // edits go through PATCH/DELETE /api/admin/task-responses per row.
  type EditableResponse = {
    id: string;
    field_type: string | null;
    field_label: string | null;
    field_id: string | null;
    file_name: string | null;
    file_url: string | null;
    value: string | null;
    // Local-only flags so save can diff against the loaded snapshot.
    deleted?: boolean;
  };
  // Definition of a single configurable form-field on a task template.
  // Pulled from `task_form_fields` so the admin sees every field the client
  // form would render — including ones the user left blank.
  type TaskFormField = {
    id: string;
    field_type: string;
    label: string;
    placeholder: string | null;
    required: boolean | null;
    order_index: number;
    options: any;
  };

  // Mapping from a form-field's (normalized lowercase) label to the
  // camelCase key accepted by PUT /api/admin/leads. Used both for
  // pre-filling empty fields from the lead's existing record AND for
  // writing admin overrides back so the leads table (and customer-
  // facing app) reflects the change.
  const LEAD_FIELD_BY_LABEL: Record<string, string> = {
    "first name": "firstName",
    "given name": "firstName",
    "last name": "lastName",
    "surname": "lastName",
    "family name": "lastName",
    "email": "email",
    "email address": "email",
    "phone": "phone",
    "phone number": "phone",
    "mobile": "phone",
    "mobile number": "phone",
    "cell": "phone",
    "cell phone": "phone",
    "employer phone": "employerPhone",
    "occupation": "occupation",
    "marital status": "maritalStatus",
    "citizenship": "citizenshipStatus",
    "citizenship status": "citizenshipStatus",
    "property type": "propertyType",
    "ownership history": "ownershipHistory",
    "corporate name": "corporateName",
    "company name": "corporateName",
    "inc number": "incNumber",
    "incorporation number": "incNumber",
    "address": "addressStreet",
    "street address": "addressStreet",
    "street": "addressStreet",
    "unit": "addressUnit",
    "apt": "addressUnit",
    "suite": "addressUnit",
    "apartment": "addressUnit",
    "city": "addressCity",
    "province": "addressProvince",
    "state": "addressProvince",
    "postal code": "addressPostalCode",
    "zip": "addressPostalCode",
    "zip code": "addressPostalCode",
    "selling address": "sellingAddressStreet",
    "selling street": "sellingAddressStreet",
    "selling city": "sellingAddressCity",
    "selling province": "sellingAddressProvince",
    "selling postal code": "sellingAddressPostalCode",
  };

  // Reverse map: rawDeal column → camelCase key used by the lead PUT.
  // Lets us pull pre-fill values from rawDeal (which already carries the
  // lead's columns thanks to the deal [id] GET handler).
  const RAW_DEAL_LEAD_KEYS: Record<string, string> = {
    lead_first_name: "firstName",
    lead_last_name: "lastName",
    lead_email: "email",
    lead_phone: "phone",
    lead_employer_phone: "employerPhone",
    lead_occupation: "occupation",
    lead_marital_status: "maritalStatus",
    lead_citizenship_status: "citizenshipStatus",
    lead_property_type: "propertyType",
    lead_ownership_history: "ownershipHistory",
    lead_corporate_name: "corporateName",
    lead_inc_number: "incNumber",
    lead_address_street: "addressStreet",
    lead_address_unit: "addressUnit",
    lead_address_city: "addressCity",
    lead_address_province: "addressProvince",
    lead_address_postal_code: "addressPostalCode",
    lead_selling_address_street: "sellingAddressStreet",
    lead_selling_address_city: "sellingAddressCity",
    lead_selling_address_province: "sellingAddressProvince",
    lead_selling_address_postal_code: "sellingAddressPostalCode",
  };

  const getLeadFieldKeyForLabel = (label: string): string | null => {
    const norm = label.trim().toLowerCase();
    if (LEAD_FIELD_BY_LABEL[norm]) return LEAD_FIELD_BY_LABEL[norm];
    // Loose fallback: try collapsed spacing + remove non-alphanumerics.
    const loose = norm.replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
    return LEAD_FIELD_BY_LABEL[loose] ?? null;
  };

  // CHECK-constraint columns in `leads` only accept exact strings. Admin
  // form values (free-text or differently-cased) get normalized through
  // these maps before the PUT so the DB doesn't reject them with
  // "violates check constraint" errors. Keys = camelCase payload keys
  // accepted by PUT /api/admin/leads.
  const LEAD_ENUM_NORMALIZERS: Record<string, Record<string, string>> = {
    maritalStatus: {
      "single": "Single",
      "married": "Married",
      "common law": "Common Law",
      "common-law": "Common Law",
      "commonlaw": "Common Law",
      "divorced": "Divorced",
      "widowed": "Widowed",
      "widow": "Widowed",
      "widower": "Widowed",
    },
    citizenshipStatus: {
      "canadian citizen": "canadian_citizen",
      "canadian_citizen": "canadian_citizen",
      "canadian": "canadian_citizen",
      "citizen": "canadian_citizen",
      "permanent resident": "permanent_resident",
      "permanent_resident": "permanent_resident",
      "pr": "permanent_resident",
      "visa": "visa",
      "refugee status": "refugee_status",
      "refugee_status": "refugee_status",
      "refugee": "refugee_status",
      "non citizen unsure": "non_citizen_unsure",
      "non-citizen unsure": "non_citizen_unsure",
      "non_citizen_unsure": "non_citizen_unsure",
      "unsure": "non_citizen_unsure",
    },
    propertyType: {
      "primary": "Primary",
      "primary residence": "Primary",
      "investment": "Investment",
      "investment property": "Investment",
      "vacation": "Vacation",
      "vacation home": "Vacation",
      "commercial": "Commercial",
    },
    ownershipHistory: {
      "no (first time)": "No (first time)",
      "no": "No (first time)",
      "first time": "No (first time)",
      "first-time": "No (first time)",
      "yes (previous owner)": "Yes (previous owner)",
      "yes": "Yes (previous owner)",
      "previous owner": "Yes (previous owner)",
      "current owner": "Current owner",
      "current": "Current owner",
    },
    service: {
      "closing": "closing",
      "refinance": "refinance",
      "condo": "condo",
    },
    subService: {
      "buying": "buying",
      "buy": "buying",
      "purchasing": "buying",
      "selling": "selling",
      "sell": "selling",
      "both": "both",
    },
  };

  // Returns:
  //   • a normalized string if the lead column has a CHECK constraint and
  //     the value mapped to a valid enum entry
  //   • null if the lead column has a CHECK constraint but the value
  //     doesn't map (caller should SKIP the field, not send raw)
  //   • undefined if the lead column has no CHECK constraint (caller
  //     should send the raw value)
  const normalizeLeadValue = (key: string, raw: string): string | null | undefined => {
    const map = LEAD_ENUM_NORMALIZERS[key];
    if (!map) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const norm = trimmed.toLowerCase();
    return map[norm] ?? null;
  };

  // Pull current lead values keyed by the lead camelCase keys, harvested
  // from rawDeal so we don't need an extra fetch.
  const getLeadValuesFromRawDeal = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!rawDeal) return out;
    for (const [col, key] of Object.entries(RAW_DEAL_LEAD_KEYS)) {
      const v = rawDeal[col];
      if (v !== undefined && v !== null && v !== "") {
        out[key] = String(v);
      }
    }
    return out;
  };

  // Form-field validation. Returns null on success, or a user-facing
  // error string. Required-empty is handled separately before this runs.
  const validateFieldValue = (field: TaskFormField, value: string): string | null => {
    if (!value) return null; // empty is fine here; required-check runs first
    const v = value.trim();
    // Phone-by-label fallback: some templates (e.g. "Business/Employer Phone")
    // store the field with field_type="text" in the DB, so the phone case
    // below wouldn't fire. Recognise any field whose label mentions "phone"
    // and run the same digit-count check.
    const labelLower = (field.label ?? "").toLowerCase();
    const isPhoneByLabel = labelLower.includes("phone");
    if (field.field_type !== "phone" && isPhoneByLabel) {
      const digits = v.replace(/\D/g, "");
      if (digits.length < 10) return "Phone number must have at least 10 digits.";
      if (digits.length > 15) return "Phone number is too long.";
      return null;
    }
    switch (field.field_type) {
      case "email": {
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        return ok ? null : "Enter a valid email address.";
      }
      case "phone": {
        // Accept any format the user types as long as it has at least 10
        // digits. Strips parentheses, spaces, dashes, dots before counting.
        const digits = v.replace(/\D/g, "");
        if (digits.length < 10) return "Phone number must have at least 10 digits.";
        if (digits.length > 15) return "Phone number is too long.";
        return null;
      }
      case "number": {
        return Number.isFinite(Number(v)) ? null : "Enter a valid number.";
      }
      case "date": {
        return /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : "Enter a valid date.";
      }
      default: {
        // Heuristic: validate Canadian postal codes when the field is
        // labelled as such. Accept either the partial FSA (e.g. "N2V")
        // or the full A1A 1A1 form (case-insensitive, space optional).
        // Auto-formatter already enforces position rules as the admin
        // types — this is the final correctness check on save.
        if (isPostalField(field)) {
          const ok = /^[A-Za-z]\d[A-Za-z](\s?\d[A-Za-z]\d)?$/.test(v);
          return ok ? null : "Enter a valid postal code (e.g. N2V or M5V 3L9).";
        }
        return null;
      }
    }
  };
  const [editingTask, setEditingTask] = useState<DisplayTask | null>(null);
  const [editTaskTitle, setEditTaskTitle] = useState<string>("");
  const [editTaskStatus, setEditTaskStatus] = useState<string>("Pending");
  const [editTaskDueDate, setEditTaskDueDate] = useState<string>("");
  const [editTaskCompletedAt, setEditTaskCompletedAt] = useState<string>("");
  const [editTaskMilestoneId, setEditTaskMilestoneId] = useState<string>("");
  const [editTaskResponses, setEditTaskResponses] = useState<EditableResponse[]>([]);
  const [editTaskInitialResponses, setEditTaskInitialResponses] = useState<EditableResponse[]>([]);
  const [editTaskFormFields, setEditTaskFormFields] = useState<TaskFormField[]>([]);
  const [editTaskFieldErrors, setEditTaskFieldErrors] = useState<Record<string, string>>({});
  const [editTaskLoading, setEditTaskLoading] = useState(false);
  const [editTaskSaving, setEditTaskSaving] = useState(false);
  // Editable Full Name on the Personal Information task. The name is not a
  // task_form_fields row — it lives on the person's lead/client record — so it
  // saves through /api/admin/leads rather than the task-response path. The ref
  // snapshots the loaded value so a save only hits that endpoint on a change.
  const [editTaskFirstName, setEditTaskFirstName] = useState<string>("");
  const [editTaskLastName, setEditTaskLastName] = useState<string>("");
  const editTaskInitialName = useRef<{ first: string; last: string }>({ first: "", last: "" });

  // Identification upload drawer — opens instead of the normal Edit Task modal
  // when the admin clicks Pencil on a task whose title contains "identif".
  // leadId is state (not derived) so the primary's DealDetail can target a
  // co-purchaser/co-seller when the user clicks "Upload ID" on their row in
  // the People Involved section.
  const primaryLeadId = (rawDeal?.lead_id as string | undefined) ?? deal.id;
  const [idDrawerTaskId, setIdDrawerTaskId] = useState<string | null>(null);
  const [idDrawerLeadId, setIdDrawerLeadId] = useState<string>(primaryLeadId);

  // Single-party Personal Info modal (matches the customer portal's
  // PersonalInfoTaskDrawer design). Opened per-person from a "Provide Personal
  // Information" task row — no multi-party accordion. Upload ID uses the
  // dedicated UploadIdentificationDrawer via openIdDrawerFor instead.
  const [personalInfoModal, setPersonalInfoModal] = useState<{
    leadId: string;
    dealId: string;
    name: string;
    role: string;
  } | null>(null);
  const [personalInfoChanged, setPersonalInfoChanged] = useState(false);

  const openIdDrawerFor = (leadId: string, taskId: string) => {
    setIdDrawerLeadId(leadId);
    setIdDrawerTaskId(taskId);
  };

  // Clone-from-previous drawer — prepopulates a lead's personal fields and
  // identification documents from a prior deal belonging to the same client
  // (matched by email). The primary opens it from the header; co-purchasers /
  // co-sellers each get their own entry point on their People-involved row,
  // so `cloneDrawerLeadId` tracks which family member is being targeted.
  const [cloneDrawerOpen, setCloneDrawerOpen] = useState(false);
  const [cloneDrawerLeadId, setCloneDrawerLeadId] = useState<string>(primaryLeadId);

  const openCloneDrawerFor = (leadId: string) => {
    setCloneDrawerLeadId(leadId);
    setCloneDrawerOpen(true);
  };

  const isIdentificationTask = (task: DisplayTask) =>
    !task.isTemplate && (task.title ?? "").toLowerCase().includes("identif");

  // Personal-information task — the other place where cloning from a previous
  // deal makes sense (name/phone/address/citizenship rarely change between a
  // client's deals). Matched loosely on the template/title wording.
  const isPersonalInfoTask = (task: DisplayTask) => {
    if (task.isTemplate) return false;
    const t = (task.title ?? "").toLowerCase();
    return t.includes("personal info") || t.includes("personal information");
  };

  // Tasks where the "Clone from previous deal" shortcut is offered inside the
  // task modal — only the details that typically carry over unchanged.
  const isCloneableTask = (task: DisplayTask) =>
    isIdentificationTask(task) || isPersonalInfoTask(task);

  // Home Insurance upload drawer — reuses the client-portal drawer (copied into
  // the admin app) so admin can upload the policy on behalf of the client.
  const [homeInsDrawerTaskId, setHomeInsDrawerTaskId] = useState<string | null>(null);

  const isHomeInsuranceTask = (task: DisplayTask) => {
    if (task.isTemplate) return false;
    const t = (task.title ?? "").toLowerCase();
    return t.includes("home insurance") || t.includes("insurance policy");
  };

  // Mortgage / "Status of Mortgage" task. Its fields (agent name, company,
  // phone, email) describe the client's mortgage broker — NOT the client —
  // so they must never be auto-filled from the lead record. Mirrors the
  // customer portal, where these fields start blank for the client to fill.
  const isMortgageTask = (task: DisplayTask) => {
    if (task.isTemplate) return false;
    return (task.title ?? "").toLowerCase().includes("mortgage");
  };

  type IdDocRow = {
    id: string;
    file_name: string | null;
    file_url: string | null;
    custom_type: string | null;
  };
  const [editTaskIdDocs, setEditTaskIdDocs] = useState<IdDocRow[]>([]);
  const [editTaskIdDocsLoading, setEditTaskIdDocsLoading] = useState(false);

  const fetchEditTaskIdDocs = async () => {
    if (!idDrawerLeadId) return;
    setEditTaskIdDocsLoading(true);
    try {
      const res = await fetch(
        `/api/admin/lead-identification-docs?lead_id=${encodeURIComponent(idDrawerLeadId)}`,
      );
      const data = await res.json();
      if (data.success) setEditTaskIdDocs(data.docs ?? []);
    } catch {
      // Non-fatal — the upload drawer can still be opened to add documents.
    } finally {
      setEditTaskIdDocsLoading(false);
    }
  };

  const formatIdDocLabel = (customType: string | null): string => {
    if (!customType) return "Identification Document";
    return customType
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const openEditTask = async (task: DisplayTask) => {
    // On a co-person deal, the two per-person tasks (Personal Info / Upload ID)
    // open the single-party drawer for THAT person — same design as the customer
    // portal — instead of a multi-party accordion. Scoped to the row's owner so
    // uploads/answers land on the right person.
    if (
      !task.isTemplate &&
      familyMemberCount > 1 &&
      (isIdentificationTask(task) || isPersonalInfoTask(task))
    ) {
      const ownerLead = (task.ownerLeadId as string | null) ?? primaryLeadId;
      if (isIdentificationTask(task)) {
        openIdDrawerFor(ownerLead, task.id);
      } else {
        const person = familyPeople.find((p) => p.lead_id === ownerLead);
        setPersonalInfoChanged(false);
        setPersonalInfoModal({
          leadId: ownerLead,
          dealId: (task.ownerDealId as string | null) ?? person?.id ?? deal.id,
          name: (task.ownerName as string | null) ?? person?.lead_name ?? "",
          role: person?.role ?? "",
        });
      }
      return;
    }
    setEditingTask(task);
    if (isIdentificationTask(task)) {
      void fetchEditTaskIdDocs();
    }
    setEditTaskTitle(task.title ?? "");
    setEditTaskStatus(task.status ?? "Pending");
    setEditTaskDueDate(task.dueDate ?? "");
    setEditTaskCompletedAt(task.completedAt ? task.completedAt.slice(0, 10) : "");
    setEditTaskMilestoneId(task.milestoneId ?? "");
    setEditTaskResponses([]);
    setEditTaskInitialResponses([]);
    setEditTaskFormFields([]);
    if (task.isTemplate) return;
    setEditTaskLoading(true);
    try {
      // Fetch template form-field definitions + already-submitted responses
      // together. The Edit modal renders one row per template field, pre-
      // filled with the response (matched by field_id, fallback field_label).
      const fieldsUrl = task.taskTemplateId
        ? `/api/admin/task-form-fields?task_template_id=${encodeURIComponent(task.taskTemplateId)}`
        : null;
      const [responsesRes, fieldsRes] = await Promise.all([
        fetch(`/api/admin/task-responses?task_id=${task.id}`),
        fieldsUrl ? fetch(fieldsUrl) : Promise.resolve(null),
      ]);
      const responsesData = await responsesRes.json();
      if (Array.isArray(responsesData)) {
        const mapped: EditableResponse[] = responsesData.map((r: any) => ({
          id: r.id ?? r.response_id,
          field_type: r.field_type ?? null,
          field_label: r.field_label ?? null,
          field_id: r.field_id ?? null,
          file_name: r.file_name ?? null,
          file_url: r.file_url ?? null,
          value: r.value ?? r.text_value ?? null,
        }));
        setEditTaskResponses(mapped);
        setEditTaskInitialResponses(mapped.map((r) => ({ ...r })));
      }
      if (fieldsRes) {
        const fieldsData = await fieldsRes.json();
        if (Array.isArray(fieldsData)) {
          const fields: TaskFormField[] = fieldsData.map((f: any) => ({
            id: f.id,
            field_type: f.field_type,
            label: f.label,
            placeholder: f.placeholder ?? null,
            required: f.required ?? false,
            order_index: f.order_index ?? 0,
            options: f.options ?? null,
          }));
          setEditTaskFormFields(fields);

          // Pre-fill empty fields from the lead row when the label maps
          // to a known lead column (e.g. "Phone Number" → leads.phone).
          // Skips fields that already have a response so we never clobber
          // a client-submitted value.
          const existingResponses = Array.isArray(responsesData) ? responsesData : [];
          const respByFieldId = new Map<string, any>(
            existingResponses.filter((r: any) => r.field_id).map((r: any) => [r.field_id, r]),
          );
          const respByLabel = new Map<string, any>(
            existingResponses.filter((r: any) => !r.field_id && r.field_label).map((r: any) => [r.field_label, r]),
          );
          // In the unified family view, a personal task may belong to a
          // co-person (their own deal). `getLeadValuesFromRawDeal` only knows
          // the PRIMARY lead, so for an owner row prefill from the owner's
          // name/phone (carried on the task) instead of the primary's.
          const isOwnerRow = !!task.ownerDealId && task.ownerDealId !== deal.id;
          const leadValues = isOwnerRow
            ? {
                firstName: task.ownerFirstName ?? "",
                lastName: task.ownerLastName ?? "",
                phone: task.ownerPhone ?? "",
              }
            : getLeadValuesFromRawDeal();
          const prefillRows: EditableResponse[] = [];
          // Mortgage task fields refer to the client's mortgage broker, not
          // the client, so we never auto-populate them from the lead — they
          // stay blank just like in the customer portal.
          const allowLeadPrefill = !isMortgageTask(task);
          // The Personal Information task must only auto-fill the person's name
          // and phone. In particular the lead's address_* is the PROPERTY
          // address (also used as deal.property_address), so pre-filling a
          // personal address field with it is wrong — keep it (and everything
          // else) blank here. Admin can still type+save these manually.
          const personalInfoStrict = isPersonalInfoTask(task);
          const PERSONAL_INFO_PREFILL_KEYS = new Set(["firstName", "lastName", "phone"]);
          for (const field of fields) {
            if (!allowLeadPrefill) break;
            const alreadyAnswered =
              respByFieldId.has(field.id) || respByLabel.has(field.label);
            if (alreadyAnswered) continue;
            if (field.field_type === "file" || field.field_type === "checkbox") continue;
            const leadKey = getLeadFieldKeyForLabel(field.label);
            if (!leadKey) continue;
            if (personalInfoStrict && !PERSONAL_INFO_PREFILL_KEYS.has(leadKey)) continue;
            const v = leadValues[leadKey];
            if (!v) continue;
            // Normalize phone / postal pre-fills through the same formatter
            // the input uses so storage matches display once admin saves.
            const isPhoneField =
              field.field_type === "phone" ||
              (field.label ?? "").toLowerCase().includes("phone");
            const normalized = isPhoneField
              ? formatPhoneAsTyped(v)
              : isPostalField(field)
              ? formatPostalAsTyped(v)
              : v;
            prefillRows.push({
              id: `tmp-${field.id}`,
              field_id: field.id,
              field_label: field.label,
              field_type: field.field_type,
              file_name: null,
              file_url: null,
              value: normalized,
            });
          }
          if (prefillRows.length > 0) {
            setEditTaskResponses((prev) => [...prev, ...prefillRows]);
          }
        }
      }
    } catch {
      // Non-blocking: editor still works for task fields even if responses fail
    } finally {
      setEditTaskLoading(false);
    }
  };

  const closeEditTask = () => {
    setEditingTask(null);
    setEditTaskTitle("");
    setEditTaskStatus("Pending");
    setEditTaskDueDate("");
    setEditTaskCompletedAt("");
    setEditTaskMilestoneId("");
    setEditTaskResponses([]);
    setEditTaskInitialResponses([]);
    setEditTaskFormFields([]);
    setEditTaskFieldErrors({});
    setEditTaskIdDocs([]);
  };

  // Refetch just the task_responses for the currently-edited task. Called
  // after the APS upload modal completes from within the Edit Task modal so
  // the newly-bridged file row appears without closing the editor.
  const refreshEditTaskResponses = async () => {
    if (!editingTask) return;
    try {
      const res = await fetch(`/api/admin/task-responses?task_id=${editingTask.id}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        const mapped: EditableResponse[] = data.map((r: any) => ({
          id: r.id ?? r.response_id,
          field_type: r.field_type ?? null,
          field_label: r.field_label ?? null,
          field_id: r.field_id ?? null,
          file_name: r.file_name ?? null,
          file_url: r.file_url ?? null,
          value: r.value ?? r.text_value ?? null,
        }));
        setEditTaskResponses(mapped);
        setEditTaskInitialResponses(mapped.map((r) => ({ ...r })));
      }
    } catch {
      // Non-blocking — modal still works without the refreshed list.
    }
  };

  const updateResponseValue = (id: string, value: string) => {
    setEditTaskResponses((prev) =>
      prev.map((r) => (r.id === id ? { ...r, value } : r)),
    );
  };

  // Look up the response row backing a given form field. Match on field_id
  // first (canonical); fall back to label for legacy rows whose field_id
  // was never set when the client submitted.
  const findResponseForField = (field: TaskFormField): EditableResponse | null => {
    return (
      editTaskResponses.find((r) => r.field_id === field.id) ??
      editTaskResponses.find((r) => !r.field_id && r.field_label === field.label) ??
      null
    );
  };

  // All (non-deleted) responses backing a field. A file field can hold more
  // than one file (e.g. APS = agreement + amendments), so the Edit Task modal
  // must list every matching response, not just the first.
  const findResponsesForField = (field: TaskFormField): EditableResponse[] => {
    return editTaskResponses.filter(
      (r) =>
        !r.deleted &&
        (r.field_id === field.id || (!r.field_id && r.field_label === field.label)),
    );
  };

  // Update or create the response backing a form field. New rows get a
  // temp id prefixed `tmp-` so saveEditTask knows to POST (rather than
  // PATCH) them at save time. Also clears any prior validation error on
  // this field so the inline message disappears as the admin fixes it.
  const setFieldValue = (field: TaskFormField, value: string) => {
    setEditTaskResponses((prev) => {
      const existingIdx = prev.findIndex(
        (r) => r.field_id === field.id || (!r.field_id && r.field_label === field.label),
      );
      if (existingIdx >= 0) {
        const next = prev.slice();
        next[existingIdx] = { ...next[existingIdx], value, deleted: false };
        return next;
      }
      const tempId = `tmp-${field.id}`;
      return [
        ...prev,
        {
          id: tempId,
          field_id: field.id,
          field_label: field.label,
          field_type: field.field_type,
          file_name: null,
          file_url: null,
          value,
        },
      ];
    });
    if (editTaskFieldErrors[field.id]) {
      setEditTaskFieldErrors((prev) => {
        const next = { ...prev };
        delete next[field.id];
        return next;
      });
    }
  };

  // Auto-format a North American phone number as the admin types so the
  // input mirrors the placeholder shape (e.g. "(416) 555-1234"). Strips
  // everything non-numeric, caps at 10 digits, and re-inserts punctuation
  // based on how many digits are present. Storage uses the formatted
  // string so the leads list / customer app shows it the same way.
  const formatPhoneAsTyped = (raw: string): string => {
    const digits = raw.replace(/\D/g, "").slice(0, 10);
    if (digits.length === 0) return "";
    if (digits.length < 4) return `(${digits}`;
    if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  // Postal code fields (Canadian) are detected by label, not field_type.
  // The template lists postal as a plain `text` field with label like
  // "Postal Code" / "Zip Code".
  const isPostalField = (field: TaskFormField): boolean => {
    return /postal|zip/.test(field.label.toLowerCase());
  };

  // Auto-format a Canadian postal code (A1A 1A1) as the admin types:
  // uppercases, drops chars in the wrong position-class (letter vs digit),
  // inserts the space after the 3rd char. Accepts an already-formatted
  // value as a no-op. Caps at 6 alphanumerics.
  const formatPostalAsTyped = (raw: string): string => {
    const positions = ["L", "D", "L", "D", "L", "D"] as const;
    const chars = raw.toUpperCase().split("");
    const valid: string[] = [];
    for (const c of chars) {
      if (valid.length >= 6) break;
      if (!/[A-Z0-9]/.test(c)) continue;
      const expected = positions[valid.length];
      if ((expected === "L" && /[A-Z]/.test(c)) || (expected === "D" && /[0-9]/.test(c))) {
        valid.push(c);
      }
      // else: silently skip — user typed a letter in a digit slot or vice versa
    }
    if (valid.length <= 3) return valid.join("");
    return `${valid.slice(0, 3).join("")} ${valid.slice(3).join("")}`;
  };

  // Parse the `options` jsonb on a select field into an array of {value,label}.
  // Tolerates either ["A","B"] or [{value, label}] shapes.
  const parseFieldOptions = (raw: any): Array<{ value: string; label: string }> => {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : [];
    return arr
      .map((opt: any) => {
        if (typeof opt === "string") return { value: opt, label: opt };
        if (opt && typeof opt === "object") {
          const v = opt.value ?? opt.val ?? opt.id ?? opt.label ?? "";
          const l = opt.label ?? opt.name ?? opt.text ?? String(v);
          return { value: String(v), label: String(l) };
        }
        return null;
      })
      .filter(Boolean) as Array<{ value: string; label: string }>;
  };
  const markResponseDeleted = (id: string) => {
    setEditTaskResponses((prev) =>
      prev.map((r) => (r.id === id ? { ...r, deleted: true } : r)),
    );
  };

  // Single file picker shared by two flows:
  //   • REPLACE: existing task_responses row → PATCH with new url + name
  //   • CREATE: no response yet → POST a new task_responses row
  // For shared (synced) tasks both endpoints mirror across the
  // co-purchaser/co-seller family. APS uploads go through the dedicated
  // APS upload modal, not this path.
  type FileUploadIntent =
    | { kind: "replace"; responseId: string; busyKey: string }
    | { kind: "create"; field: TaskFormField; busyKey: string };
  const replacingFileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileUploadIntent, setFileUploadIntent] = useState<FileUploadIntent | null>(null);
  // busyKey identifies which row/field is currently uploading so the UI
  // can disable just that button. For replace it's the response id; for
  // create it's `field-<field.id>`.
  const [replacingFileBusy, setReplacingFileBusy] = useState<string | null>(null);

  const triggerReplaceFile = (responseId: string) => {
    setFileUploadIntent({ kind: "replace", responseId, busyKey: responseId });
    // Re-open the same input even if user picks the same filename twice.
    if (replacingFileInputRef.current) {
      replacingFileInputRef.current.value = "";
      replacingFileInputRef.current.click();
    }
  };

  const triggerUploadFile = (field: TaskFormField) => {
    setFileUploadIntent({
      kind: "create",
      field,
      busyKey: `field-${field.id}`,
    });
    if (replacingFileInputRef.current) {
      replacingFileInputRef.current.value = "";
      replacingFileInputRef.current.click();
    }
  };

  const handleReplaceFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const intent = fileUploadIntent;
    if (!file || !intent) {
      setFileUploadIntent(null);
      return;
    }
    setReplacingFileBusy(intent.busyKey);
    try {
      const leadId = (rawDeal?.lead_id as string | undefined) ?? deal.id;
      const pathname = `task-responses/${leadId}/${Date.now()}-${file.name}`;
      const blob = await upload(pathname, file, {
        access: BLOB_ACCESS,
        handleUploadUrl: `/api/admin/deals/${deal.id}/uploadblobstorage/token`,
        contentType: file.type,
      });

      let res: Response;
      if (intent.kind === "replace") {
        res = await fetch("/api/admin/task-responses", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: intent.responseId,
            file_url: blob.url,
            file_name: file.name,
          }),
        });
      } else {
        if (!editingTask) throw new Error("No task open");
        res = await fetch("/api/admin/task-responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task_id: editingTask.id,
            field_id: intent.field.id,
            field_label: intent.field.label,
            field_type: intent.field.field_type,
            file_url: blob.url,
            file_name: file.name,
          }),
        });
      }
      const pj = await res.json();
      if (!res.ok || !pj.success) {
        throw new Error(pj.error || (intent.kind === "replace" ? "Failed to replace file" : "Failed to upload file"));
      }

      // Refresh everything that surfaces a doc: edit modal list, the task
      // table's Doc column, and the View Documents modal. When the server
      // auto-completed the task (last required file filled), also refresh
      // tasks + milestones so the table row flips to Completed.
      const taskCompleted = pj.task_completed === true;
      // Keep the open modal's Status dropdown in sync: when this upload was the
      // final required file, the server auto-completed the task, so reflect that
      // in the modal immediately instead of leaving the dropdown on "Pending".
      if (taskCompleted) {
        setEditTaskStatus("Completed");
      }
      await Promise.all([
        refreshEditTaskResponses(),
        fetchTaskFileDocs(),
        fetchDealDocuments(),
        ...(taskCompleted ? [refetchData()] : []),
      ]);

      const mirroredCount = typeof pj.mirrored === "number" ? pj.mirrored : 0;
      const baseMessage = intent.kind === "replace" ? "File replaced" : "File uploaded";
      const suffix = taskCompleted ? " Task marked Completed." : "";
      showToast(
        mirroredCount > 0
          ? `${baseMessage} and synced to ${mirroredCount} linked deal${mirroredCount === 1 ? "" : "s"}.${suffix}`
          : `${baseMessage}.${suffix}`,
      );
    } catch (err: any) {
      showToast(err?.message ?? "Failed to upload file", "error");
    } finally {
      setReplacingFileBusy(null);
      setFileUploadIntent(null);
    }
  };

  const saveEditTask = async () => {
    if (!editingTask) return;
    const nextTitle = editTaskTitle.trim();
    if (!nextTitle) {
      showToast("Title cannot be empty", "error");
      return;
    }

    // Per-field validation pass. Blocks save when any field is invalid
    // and surfaces a per-field error message under the input.
    if (editTaskFormFields.length > 0) {
      const errors: Record<string, string> = {};
      for (const field of editTaskFormFields) {
        if (field.field_type === "file") continue;
        const resp = findResponseForField(field);
        const value = (resp?.value ?? "").trim();
        if (field.required && !value && !resp?.deleted) {
          errors[field.id] = "This field is required.";
          continue;
        }
        const err = validateFieldValue(field, value);
        if (err) errors[field.id] = err;
      }
      if (Object.keys(errors).length > 0) {
        setEditTaskFieldErrors(errors);
        showToast("Fix the highlighted fields before saving.", "error");
        return;
      }
      setEditTaskFieldErrors({});
    }
    setEditTaskSaving(true);
    try {
      // Build the task PATCH payload — only send fields that actually changed
      // so we don't override values touched elsewhere (e.g. completed_at on
      // status flip is handled server-side).
      const payload: Record<string, any> = { id: editingTask.id };
      if (nextTitle !== editingTask.title) payload.title = nextTitle;
      if (editTaskStatus !== (editingTask.status ?? "Pending")) {
        payload.status = editTaskStatus;
        if (editTaskStatus === "Completed") {
          payload.completed = true;
          payload.completed_at = new Date().toISOString();
        } else {
          payload.completed = false;
          payload.completed_at = null;
        }
      }
      const dueChanged = (editTaskDueDate || null) !== (editingTask.dueDate || null);
      if (dueChanged) payload.due_date = editTaskDueDate || null;
      const milestoneChanged = (editTaskMilestoneId || null) !== (editingTask.milestoneId || null);
      if (milestoneChanged) payload.milestone_id = editTaskMilestoneId || null;
      // Allow manual override of completed_at when the user edits the date
      // directly. We only treat it as a change when the user picked something
      // different from the date that's already on file.
      const initialCompletedSlice = editingTask.completedAt ? editingTask.completedAt.slice(0, 10) : "";
      if (editTaskCompletedAt !== initialCompletedSlice) {
        payload.completed_at = editTaskCompletedAt
          ? new Date(`${editTaskCompletedAt}T00:00:00Z`).toISOString()
          : null;
      }

      // Auto-complete on save: filling in a task's required content IS
      // completing it, so the admin shouldn't also have to flip the Status
      // dropdown. When every required field is satisfied and the admin hasn't
      // explicitly picked a status, mark the task Completed (mirrors the
      // customer portal's auto-complete on submit). Scoped to editingTask.id.
      // Skipped when the admin explicitly chose a status from the dropdown so
      // an intentional "Pending" is still respected.
      //
      // "Satisfied" means: required non-file fields have a value (already
      // guaranteed by the validation above, which blocks save otherwise) AND
      // every required file field has an uploaded response. File uploads also
      // auto-complete server-side via maybeCompleteFileTask on the final
      // upload; this is the save-time equivalent for the rest of the fields.
      const statusUnchanged = editTaskStatus === (editingTask.status ?? "Pending");
      const requiredFields = editTaskFormFields.filter((f) => f.required);
      const allRequiredFilled =
        requiredFields.length > 0 &&
        requiredFields.every((field) => {
          if (field.field_type === "file") {
            return findResponsesForField(field).some((r) => !!r.file_url);
          }
          const resp = findResponseForField(field);
          return !resp?.deleted && !!(resp?.value ?? "").trim();
        });
      if (
        statusUnchanged &&
        editTaskStatus !== "Completed" &&
        // Personal Information tasks stay auto-completing even if they carry no
        // strictly-required fields, preserving the prior behaviour.
        (allRequiredFilled || isPersonalInfoTask(editingTask))
      ) {
        payload.status = "Completed";
        payload.completed = true;
        payload.completed_at = payload.completed_at ?? new Date().toISOString();
      }

      if (Object.keys(payload).length > 1) {
        const res = await fetch("/api/admin/tasks", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || "Failed to save task");
      }

      // Reconcile client responses:
      //   - rows flagged `deleted`        → DELETE
      //   - rows with id "tmp-…"          → POST (admin filled an empty field)
      //   - existing rows w/ changed value → PATCH
      //   - file rows                     → skipped (Replace flow handles them)
      const initialById = new Map(editTaskInitialResponses.map((r) => [r.id, r]));
      for (const r of editTaskResponses) {
        const initial = initialById.get(r.id);
        if (r.deleted) {
          if (initial) {
            const dres = await fetch(`/api/admin/task-responses?id=${encodeURIComponent(r.id)}`, {
              method: "DELETE",
            });
            const dj = await dres.json();
            if (!dres.ok || !dj.success) throw new Error(dj.error || "Failed to delete response");
          }
          continue;
        }
        if (r.field_type === "file") continue;

        const isTemp = r.id.startsWith("tmp-");
        if (isTemp) {
          // Skip empty new rows so the admin isn't forced to POST blanks.
          if ((r.value ?? "") === "") continue;
          const cres = await fetch("/api/admin/task-responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              task_id: editingTask.id,
              field_id: r.field_id,
              field_label: r.field_label,
              field_type: r.field_type,
              value: r.value ?? "",
            }),
          });
          const cj = await cres.json();
          if (!cres.ok || !cj.success) throw new Error(cj.error || "Failed to create response");
          continue;
        }

        if (initial && (initial.value ?? "") !== (r.value ?? "")) {
          const pres = await fetch("/api/admin/task-responses", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: r.id, value: r.value ?? "" }),
          });
          const pj = await pres.json();
          if (!pres.ok || !pj.success) throw new Error(pj.error || "Failed to update response");
        }
      }

      // Two-way sync to leads: for any form field whose label maps to a
      // lead column (phone, address, etc.), also PUT the value back to
      // /api/admin/leads so the customer-facing app and the leads list
      // reflect the admin's edit. Non-blocking — task save already
      // succeeded; a lead-sync failure surfaces as a toast warning.
      const leadId = rawDeal?.lead_id as string | undefined;
      if (leadId && editTaskFormFields.length > 0) {
        const leadPayload: Record<string, any> = {};
        const skippedEnum: Array<{ label: string; value: string }> = [];
        for (const field of editTaskFormFields) {
          if (field.field_type === "file") continue;
          const leadKey = getLeadFieldKeyForLabel(field.label);
          if (!leadKey) continue;
          const resp = findResponseForField(field);
          if (!resp || resp.deleted) continue;
          const rawValue = resp.value ?? "";

          // Some lead columns have CHECK constraints (marital_status,
          // citizenship_status, property_type, ownership_history,
          // service, sub_service). Normalize through the map so admin-
          // entered variants ("single", "common-law") become the exact
          // strings the DB accepts. If no match, skip the field and warn
          // the admin — better than failing the whole sync.
          const norm = normalizeLeadValue(leadKey, rawValue);
          if (norm === null) {
            skippedEnum.push({ label: field.label, value: rawValue });
            continue;
          }
          leadPayload[leadKey] = norm === undefined ? rawValue : norm;
        }
        if (Object.keys(leadPayload).length > 0) {
          try {
            const lres = await fetch("/api/admin/leads", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: leadId, ...leadPayload }),
            });
            const lj = await lres.json();
            if (!lres.ok || !lj.success) {
              showToast(
                `Task saved, but lead sync failed: ${lj.error ?? "unknown"}`,
                "error",
              );
            }
          } catch (err: any) {
            showToast(
              `Task saved, but lead sync failed: ${err?.message ?? "network error"}`,
              "error",
            );
          }
        }
        if (skippedEnum.length > 0) {
          const list = skippedEnum
            .map((s) => `${s.label}="${s.value || "(blank)"}"`)
            .join(", ");
          showToast(
            `Some fields couldn't sync to the lead because the value doesn't match an allowed option: ${list}`,
            "error",
          );
        }
      }

      showToast("Task updated");
      closeEditTask();
      await Promise.all([
        refetchData(),
        fetchTaskFileDocs(),
        fetchDealDocuments(),
      ]);
    } catch (err: any) {
      showToast(err?.message ?? "Failed to save task", "error");
    } finally {
      setEditTaskSaving(false);
    }
  };

  // Inline milestone title edit — milestones already have status + date
  // inline; the pencil only handles title because there's no equivalent
  // "view" modal to mirror for milestones.
  const [editingMilestoneTitleId, setEditingMilestoneTitleId] = useState<string | null>(null);
  const [milestoneTitleDraft, setMilestoneTitleDraft] = useState<string>("");
  const beginEditMilestoneTitle = (id: string, title: string) => {
    setEditingMilestoneTitleId(id);
    setMilestoneTitleDraft(title);
  };
  const cancelEditMilestoneTitle = () => {
    setEditingMilestoneTitleId(null);
    setMilestoneTitleDraft("");
  };
  const saveEditMilestoneTitle = async (id: string) => {
    const next = milestoneTitleDraft.trim();
    if (!next) {
      showToast("Title cannot be empty", "error");
      return;
    }
    const prevTitle = milestones.find((m) => m.id === id)?.title;
    if (next === prevTitle) {
      cancelEditMilestoneTitle();
      return;
    }
    setMilestones((prev) => prev.map((m) => (m.id === id ? { ...m, title: next } : m)));
    cancelEditMilestoneTitle();
    try {
      const res = await fetch("/api/admin/milestones", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, title: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to rename milestone");
      showToast("Milestone renamed");
    } catch (err: any) {
      showToast(err?.message ?? "Failed to rename milestone", "error");
      await refetchData();
    }
  };

  // Edit Milestone modal state — Pencil on a milestone row opens this and
  // lets users edit all milestone details (title, status, date) in one place,
  // mirroring the Edit Task modal flow.
  const [editingMilestone, setEditingMilestone] = useState<Milestone | null>(null);
  const [editMilestoneTitle, setEditMilestoneTitle] = useState<string>("");
  const [editMilestoneStatus, setEditMilestoneStatus] = useState<Milestone["status"]>("Pending");
  const [editMilestoneDate, setEditMilestoneDate] = useState<string>("");
  const [editMilestoneEmailTemplateId, setEditMilestoneEmailTemplateId] = useState<string>("");
  const [editMilestoneSaving, setEditMilestoneSaving] = useState(false);

  const openEditMilestone = (m: Milestone) => {
    setEditingMilestone(m);
    setEditMilestoneTitle(m.title);
    setEditMilestoneStatus((m.status || "Pending") as Milestone["status"]);
    setEditMilestoneDate(m.milestoneDate ?? "");
    setEditMilestoneEmailTemplateId(m.emailTemplateId ?? "");
  };

  const closeEditMilestone = () => {
    setEditingMilestone(null);
    setEditMilestoneTitle("");
    setEditMilestoneStatus("Pending");
    setEditMilestoneDate("");
    setEditMilestoneEmailTemplateId("");
  };

  const saveEditMilestone = async () => {
    if (!editingMilestone) return;
    const id = editingMilestone.id;
    const nextTitle = editMilestoneTitle.trim();
    if (!nextTitle) {
      showToast("Title cannot be empty", "error");
      return;
    }
    setEditMilestoneSaving(true);
    try {
      const prev = editingMilestone;
      const titleChanged = nextTitle !== prev.title;
      const dateChanged = (editMilestoneDate || "") !== (prev.milestoneDate || "");
      const statusChanged = (editMilestoneStatus || "Pending") !== (prev.status || "Pending");
      const emailTemplateChanged = (editMilestoneEmailTemplateId || "") !== (prev.emailTemplateId || "");

      // Patch title/date/email-template directly. Status uses the existing
      // handler because it cascades to child tasks and may trigger an email.
      if (titleChanged || dateChanged || emailTemplateChanged) {
        const payload: any = { id };
        if (titleChanged) payload.title = nextTitle;
        if (dateChanged) payload.milestone_date = editMilestoneDate || null;
        if (emailTemplateChanged) payload.email_template_id = editMilestoneEmailTemplateId || null;
        const res = await fetch("/api/admin/milestones", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.success === false) {
          throw new Error(data.error || "Failed to update milestone");
        }
        setMilestones((p) => p.map((m) => m.id === id ? {
          ...m,
          ...(titleChanged ? { title: nextTitle } : {}),
          ...(dateChanged ? { milestoneDate: editMilestoneDate || undefined } : {}),
          ...(emailTemplateChanged ? { emailTemplateId: editMilestoneEmailTemplateId || null } : {}),
        } : m));
      }

      if (statusChanged) {
        await handleMilestoneStatusChange(id, editMilestoneStatus);
      }

      if (titleChanged || dateChanged || statusChanged || emailTemplateChanged) {
        showToast("Milestone updated");
      }
      closeEditMilestone();
    } catch (err: any) {
      showToast(err?.message ?? "Failed to update milestone", "error");
    } finally {
      setEditMilestoneSaving(false);
    }
  };

  // Drag and Drop State
  const dragTaskItem = useRef<number | null>(null);
  const dragTaskOverItem = useRef<number | null>(null);
  const dragMilestoneItem = useRef<number | null>(null);
  const dragMilestoneOverItem = useRef<number | null>(null);

  const refetchData = async () => {
    try {
      const [tasksRes, milestonesRes] = await Promise.all([
        fetch(tasksFetchUrl),
        fetch(`/api/admin/milestones?deal_id=${deal.id}`),
      ]);
      const tasksData = await tasksRes.json();
      const milestonesData = await milestonesRes.json();
      if (Array.isArray(tasksData)) setTasks(tasksData.map(mapApiTask));
      if (Array.isArray(milestonesData)) {
        setMilestones(milestonesData.map((m: any): Milestone => ({
          id: m.id,
          title: m.title,
          status: m.status ?? "",
          milestoneDate: m.milestone_date ?? undefined,
          completedAt: m.completed_at ?? undefined,
          emailSent: m.email_sent ?? false,
          emailTemplateId: m.email_template_id ?? null,
          stageTemplateId: m.stage_template_id ?? null,
          leadType: m.stage_templates?.lead_type ?? null,
          orderIndex: m.order_index ?? null,
        })));
      }
    } catch { }
  };

  const fetchDealDocuments = async () => {
    setLoadingDocs(true);
    try {
      const res = await fetch(`/api/admin/task-responses?deal_id=${deal.id}${includeFamilyTasks ? "&include_family=1" : ""}`);
      const data = await res.json();
      if (Array.isArray(data)) setDealDocuments(data);
    } catch {
      setDealDocuments([]);
    } finally {
      setLoadingDocs(false);
    }
  };

  // Preflight the APS upload modal: when it opens, ask the server whether
  // an APS already exists for this deal's family so we can warn that
  // submitting will replace the existing file.
  useEffect(() => {
    if (!showApsUpload) {
      setExistingApsCount(0);
      setApsStatusLoading(false);
      return;
    }
    let cancelled = false;
    setApsStatusLoading(true);
    setExistingApsCount(0);
    (async () => {
      try {
        const sideQs = apsUploadSide ? `?side=${apsUploadSide}` : "";
        const res = await fetch(`/api/admin/deals/${deal.id}/aps-status${sideQs}`);
        const json = await res.json();
        if (cancelled) return;
        if (json?.uploaded) {
          setExistingApsCount(
            typeof json.count === "number"
              ? json.count
              : (json.file_names?.length ?? 1),
          );
        }
      } catch {
        // Non-blocking — finalize endpoint will still replace if needed.
      } finally {
        if (!cancelled) setApsStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showApsUpload, deal.id, apsUploadSide]);

  const handleApsUploadSubmit = async () => {
    if (apsFiles.length === 0) return;
    setUploadingAps(true);
    try {
      // Step 1: direct browser → Vercel Blob upload for each file (bypasses
      // the 4.5MB serverless body limit). Token issued by
      // /uploadblobstorage/token. Uploads run sequentially — lowest risk and
      // each file gets its own blob URL.
      const leadId = (rawDeal?.lead_id as string | undefined) ?? deal.id;
      const uploaded: { file_url: string; file_name: string }[] = [];
      for (const file of apsFiles) {
        const pathname = `corporate-docs/${leadId}/${Date.now()}-${file.name}`;
        const blob = await upload(pathname, file, {
          access: BLOB_ACCESS,
          handleUploadUrl: `/api/admin/deals/${deal.id}/uploadblobstorage/token`,
          contentType: file.type,
        });
        uploaded.push({ file_url: blob.url, file_name: file.name });
      }

      // Step 2: finalize — record the doc(s) and complete the APS task
      // (with family sync + milestone recalc). When the upload is being
      // submitted from the Edit Task modal on a specific side's APS
      // task, pass `side` so the server only touches that side — a
      // Purchase upload on a P&S deal must not leak into the Sale APS.
      // An explicit side chosen from the header takes precedence; otherwise
      // fall back to the side derived from the APS task being edited.
      const editingTemplateLeadType = editingTask?.taskTemplateId
        ? (taskTemplates as any[]).find((t) => t.id === editingTask.taskTemplateId)?.lead_type
        : null;
      const ltNorm = (editingTemplateLeadType ?? "").toString().toLowerCase().trim();
      const editSide = ltNorm === "purchase" ? "purchase" : ltNorm === "sale" ? "sale" : null;
      const side = apsUploadSide ?? editSide;
      const res = await fetch(`/api/admin/deals/${deal.id}/uploadblobstorage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: uploaded,
          ...(side ? { side } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Upload failed");
      }

      const n = uploaded.length;
      showToast(
        json.already_completed
          ? `${n} APS document${n === 1 ? "" : "s"} uploaded. Task was already completed.`
          : `${n} APS document${n === 1 ? "" : "s"} uploaded. Task completed and synced.`,
        "success",
      );
      setShowApsUpload(false);
      setApsFiles([]);
      // Refresh every doc-backed surface so the new file shows up in the
      // task table's Doc column and in the View Documents modal — both on
      // this open render and on next open.
      await Promise.all([
        refetchData(),
        fetchTaskFileDocs(),
        fetchLeadCorporateDocs(),
        fetchDealDocuments(),
        // If the APS upload modal was opened from inside the Edit Task
        // editor, reload its response list so the freshly-bridged file
        // row appears in place of the old one without closing the editor.
        refreshEditTaskResponses(),
      ]);
    } catch (err: any) {
      showToast(err?.message ?? "Upload failed", "error");
    } finally {
      setUploadingAps(false);
    }
  };

  // Delete a single APS file (by its blob URL) from the family. Removes both
  // the lead_corporate_docs row and the bridged task_response so the bridge
  // can't resurrect it, then refreshes every doc-backed surface.
  const handleApsDocFileDelete = async (fileUrl: string | null | undefined) => {
    if (!fileUrl) return;
    setDeletingApsDocUrl(fileUrl);
    try {
      const res = await fetch(
        `/api/admin/deals/${deal.id}/aps-document?file_url=${encodeURIComponent(fileUrl)}`,
        { method: "DELETE" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || "Failed to delete file");
      }
      // Drop it from the open popup immediately; close if it was the last one.
      setTaskDocsPopup((prev) =>
        prev
          ? (() => {
              const remaining = prev.docs.filter((d: any) => d.file_url !== fileUrl);
              return remaining.length > 0 ? { ...prev, docs: remaining } : null;
            })()
          : prev,
      );
      showToast("APS file removed.", "success");
      await Promise.all([
        refetchData(),
        fetchTaskFileDocs(),
        fetchLeadCorporateDocs(),
        fetchDealDocuments(),
        refreshEditTaskResponses(),
      ]);
    } catch (err: any) {
      showToast(err?.message ?? "Failed to delete file", "error");
    } finally {
      setDeletingApsDocUrl(null);
    }
  };

  // --- Handlers ---

  // Milestones
  const handleMilestoneStatusChange = async (
    id: string,
    newStatus: Milestone["status"],
  ) => {

    // Optimistic UI update (already exists)
    setMilestones((prev) =>
      prev.map((m) => {
        if (m.id === id) {
          const updates: Partial<Milestone> = { status: newStatus };
          if (newStatus === "Completed" && !m.completedAt) {
            updates.completedAt = new Date().toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            });
          } else if (newStatus !== "Completed") {
            updates.completedAt = undefined;
          }
          return { ...m, ...updates };
        }
        return m;
      }),
    );

    // Update all tasks under this milestone to match the new status
    const milestoneTasks = tasks.filter((t) => t.milestoneId === id);
    const hasSharedTasks = milestoneTasks.some((t) => t.isShared);
    if (newStatus === "Completed") {
      // Mark all pending/in-progress tasks under this milestone as completed
      for (const task of milestoneTasks) {
        if (task.status !== "Completed") {
          await fetch("/api/admin/tasks", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: task.id,
              status: "Completed",
              completed: true,
              completed_at: new Date().toISOString(),
            }),
          });
        }
      }

      const milestone = milestones.find((m) => m.id === id);
      if (milestone?.emailTemplateId) {
        // Send email — only send to linked deals if milestone has shared tasks
        try {
          const res = await fetch("/api/admin/send-milestone-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ milestoneId: id, dealId: deal.id, sendToLinkedDeals: true }),
          });
          const data = await res.json();
          if (data.success) {
            const linkedMsg = data.linked_emails_sent > 0
              ? ` (also sent to ${data.linked_emails_sent} linked deal${data.linked_emails_sent > 1 ? "s" : ""})`
              : "";
            if (data.skipped) {
              showToast(data.message || "Email skipped — template is inactive.", "error");
            } else if (data.alreadySent) {
              showToast("Email was already sent for this milestone.");
            } else {
              showToast(`Milestone email sent successfully!${linkedMsg}`);
            }
          } else {
            showToast(data.error || "Failed to send milestone email", "error");
          }
        } catch {
          showToast("Failed to send milestone email", "error");
        }
      } else {
        // No email template — update status + completed_at
        const r = await fetch("/api/admin/milestones", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status: newStatus, completed_at: new Date().toISOString() }),
        });
        const rj = await r.json().catch(() => ({}));
        const mm = typeof rj?.mirroredMilestones === "number" ? rj.mirroredMilestones : 0;
        const mt = typeof rj?.mirroredTasks === "number" ? rj.mirroredTasks : 0;
        if (mm > 0 || mt > 0) {
          const parts: string[] = [];
          if (mm > 0) parts.push(`${mm} milestone${mm === 1 ? "" : "s"}`);
          if (mt > 0) parts.push(`${mt} task${mt === 1 ? "" : "s"}`);
          showToast(`Milestone completed and synced to ${parts.join(" + ")} on linked deals.`);
        }
      }
    } else {
      // Reset tasks under this milestone to match the new status
      for (const task of milestoneTasks) {
        if (task.status === "Completed") {
          await fetch("/api/admin/tasks", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: task.id,
              status: "Pending",
              completed: false,
              completed_at: null,
            }),
          });
        }
      }

      // Moving away from Completed — clear completed_at and reset email_sent
      const r = await fetch("/api/admin/milestones", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: newStatus, completed_at: null, email_sent: false }),
      });
      const rj = await r.json().catch(() => ({}));
      const mm = typeof rj?.mirroredMilestones === "number" ? rj.mirroredMilestones : 0;
      const mt = typeof rj?.mirroredTasks === "number" ? rj.mirroredTasks : 0;
      if (mm > 0 || mt > 0) {
        const parts: string[] = [];
        if (mm > 0) parts.push(`${mm} milestone${mm === 1 ? "" : "s"}`);
        if (mt > 0) parts.push(`${mt} task${mt === 1 ? "" : "s"}`);
        showToast(`Status synced to ${parts.join(" + ")} on linked deals.`);
      }
    }

    await refetchData();
  };

  const handleSendMilestoneEmail = async (milestoneId: string) => {
    const milestone = milestones.find((m) => m.id === milestoneId);
    if (milestone?.status !== "Completed") {
      alert("Email can only be sent for completed stages.");
      return;
    }
    const res = await fetch("/api/admin/send-milestone-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milestoneId, dealId: deal.id, sendToLinkedDeals: true }),
    });
    const data = await res.json();
    if (data.success) {
      const linkedMsg = data.linked_emails_sent > 0
        ? ` (also sent to ${data.linked_emails_sent} linked deal${data.linked_emails_sent > 1 ? "s" : ""})`
        : "";
      if (data.skipped) {
        showToast(data.message || "Email skipped — template is inactive.", "error");
      } else if (data.alreadySent) {
        showToast("Email was already sent for this milestone.");
      } else {
        showToast(`Milestone email sent successfully!${linkedMsg}`);
      }
      await refetchData();
    } else {
      showToast(data.error || "Failed to send milestone email", "error");
    }
  };

  // Persist a per-deal milestone reorder. Operates on the displayed rows (which
  // are sorted by order_index), renumbers the real milestones sequentially, and
  // saves each new order_index. The drag indices are positions in
  // displayMilestones. NOTE: a later milestone-template reorder will overwrite
  // these per-deal values (it propagates order_index to all deals).
  const handleSortMilestones = async () => {
    const from = dragMilestoneItem.current;
    const to = dragMilestoneOverItem.current;
    dragMilestoneItem.current = null;
    dragMilestoneOverItem.current = null;
    if (from === null || to === null || from === to) return;

    const reordered = [...displayMilestones];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    // Only real (non-ghost) milestones have a DB row to persist. Per-person
    // split rows carry a synthetic id (`<id>::<ownerDealId>`) and no DB row, so
    // they're excluded too.
    const items = reordered
      .filter((m) => !m.isTemplate && !(m as DisplayMilestone).isPersonalSplit)
      .map((m, i) => ({ id: m.id, order_index: i }));
    const orderById = new Map(items.map((it) => [it.id, it.order_index]));

    // Optimistic: write the new order back so displayMilestones re-sorts now.
    setMilestones((prev) =>
      prev.map((m) =>
        orderById.has(m.id) ? { ...m, orderIndex: orderById.get(m.id)! } : m,
      ),
    );

    try {
      await fetch("/api/admin/milestones", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
    } catch {
      // Non-blocking; a refetch would restore server order.
    }
  };

  // Tasks
  const handleTaskStatusChange = async (id: string, newStatus: Task["status"]) => {
    const isCompleted = newStatus === "Completed";
    const completedAt = isCompleted
      ? new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
      : undefined;

    // Optimistic local update
    const updatedTasks = tasks.map((t) =>
      t.id === id ? { ...t, status: newStatus, completed: isCompleted, completedAt } : t
    );
    setTasks(updatedTasks);

    // PATCH task in DB — for shared tasks the backend mirrors the
    // update to every co-purchaser / co-seller deal automatically and
    // returns how many linked rows were touched.
    const patchRes = await fetch("/api/admin/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        status: newStatus,
        completed: isCompleted,
        completed_at: isCompleted ? new Date().toISOString() : null,
      }),
    });
    const patchJson = await patchRes.json().catch(() => ({}));
    const mirroredCount: number = typeof patchJson?.mirrored === "number" ? patchJson.mirrored : 0;
    if (mirroredCount > 0) {
      showToast(
        `Task status updated and synced to ${mirroredCount} linked deal${mirroredCount === 1 ? "" : "s"}.`,
      );
    }

    // Check if all tasks for this milestone are completed → auto-update milestone
    const task = updatedTasks.find((t) => t.id === id);
    if (task?.milestoneId) {
      const milestoneId = task.milestoneId;
      const milestoneTasks = updatedTasks.filter((t) => t.milestoneId === milestoneId);
      const allDone = milestoneTasks.length > 0 && milestoneTasks.every((t) => t.status === "Completed");
      const newMilestoneStatus = allDone ? "Completed" : "Pending";

      setMilestones((prev) =>
        prev.map((m) =>
          m.id === milestoneId
            ? { ...m, status: newMilestoneStatus as Milestone["status"], completedAt: allDone ? new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : undefined }
            : m
        )
      );

      if (allDone) {
        const milestone = milestones.find((m) => m.id === milestoneId);
        // Check if ANY task in this milestone is shared — if so, send emails to linked deals too
        const hasSharedTasks = milestoneTasks.some((t) => t.isShared);
        if (milestone?.emailTemplateId) {
          try {
            const res = await fetch("/api/admin/send-milestone-email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                milestoneId,
                dealId: deal.id,
                sendToLinkedDeals: true,
              }),
            });
            const data = await res.json();
            if (data.success) {
              const linkedMsg = data.linked_emails_sent > 0
                ? ` (also sent to ${data.linked_emails_sent} linked deal${data.linked_emails_sent > 1 ? "s" : ""})`
                : "";
              if (data.skipped) {
                showToast(data.message || "Email skipped — template is inactive.", "error");
              } else if (data.alreadySent) {
                showToast("Email was already sent for this milestone.");
              } else {
                showToast(`Milestone email sent successfully!${linkedMsg}`);
              }
            } else {
              showToast(data.error || "Failed to send milestone email", "error");
            }
          } catch {
            showToast("Failed to send milestone email", "error");
          }
        } else {
          await fetch("/api/admin/milestones", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: milestoneId, status: "Completed", completed_at: new Date().toISOString() }),
          });
        }
      } else {
        await fetch("/api/admin/milestones", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: milestoneId, status: newMilestoneStatus, completed_at: null, email_sent: false }),
        });
      }
    }

    // Re-fetch from DB to ensure UI reflects actual stored state
    await refetchData();
  };

  // Persist a per-deal task reorder. Mirrors handleSortMilestones: operates on
  // the displayed (order_index-sorted) rows, renumbers the real tasks, and saves
  // each new order_index via the batch PATCH. For a co-purchaser deal the shared
  // task rows belong to the primary deal, so saving by id keeps the family in
  // sync automatically. NOTE: a later task-template reorder overwrites these.
  const handleSortTasks = async () => {
    const from = dragTaskItem.current;
    const to = dragTaskOverItem.current;
    dragTaskItem.current = null;
    dragTaskOverItem.current = null;
    if (from === null || to === null || from === to) return;

    const reordered = [...displayTasks];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    const items = reordered
      .filter((t) => !t.isTemplate)
      .map((t, i) => ({ id: t.id, order_index: i }));
    const orderById = new Map(items.map((it) => [it.id, it.order_index]));

    // Optimistic: write the new order back so displayTasks re-sorts now.
    setTasks((prev) =>
      prev.map((t) =>
        orderById.has(t.id) ? { ...t, orderIndex: orderById.get(t.id)! } : t,
      ),
    );

    try {
      await fetch("/api/admin/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
    } catch {
      // Non-blocking; a refetch would restore server order.
    }
  };

  const getStatusColor = (status: string | undefined) => {
    switch (status) {
      case "Completed":
        return "bg-green-50 text-green-700 border-green-200";
      case "Pending":
        return "bg-yellow-50 text-yellow-700 border-yellow-200";
      default:
        return "bg-slate-50 text-slate-600 border-slate-200";
    }
  };

  const handleDeleteMilestone = async (milestoneId: string) => {
    if (!confirm("Are you sure you want to delete this stage?")) return;
    try {
      const res = await fetch(`/api/admin/milestones?id=${milestoneId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setMilestones(prev => prev.filter(m => m.id !== milestoneId));
      } else {
        alert('Failed to delete stage: ' + data.error);
      }
    } catch {
      alert('Error deleting stage.');
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("Are you sure you want to delete this task?")) return;
    // Capture the template id before we drop the task from state so the
    // ghost-row suppressor below has something to match against.
    const deletedTemplateId = tasks.find((t) => t.id === taskId)?.taskTemplateId ?? null;
    try {
      const res = await fetch(`/api/admin/tasks?id=${taskId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setTasks(prev => prev.filter(t => t.id !== taskId));
        if (deletedTemplateId) {
          setSuppressedTemplateIds((prev) => {
            const next = new Set(prev);
            next.add(deletedTemplateId);
            return next;
          });
        }
      } else {
        alert('Failed to delete task: ' + data.error);
      }
    } catch {
      alert('Error deleting task.');
    }
  };

  const getDisplayAddress = (address: string) => {
    return address.replace(/^(Purchase|Sale|Refinance) of\s+/i, "");
  };

  const handleSaveTask = async () => {
    if (!taskForm.title || !taskForm.client) return;

    try {
      // The dropdown stores the template's id in `taskForm.title` so that
      // templates sharing a display name (e.g. Purchase vs Sale APS, both
      // "Upload Complete Agreement of Purchase and Sale and Amendments")
      // resolve unambiguously. The task title sent to the API is the
      // template's actual name; is_shared mirrors the template so a
      // re-added shared task fans out family-wide just like the
      // auto-seeded original.
      const selectedTemplate = taskTemplates.find((t) => t.id === taskForm.title) ?? null;
      const isShared = Boolean(selectedTemplate?.is_shared);
      // `taskForm.client` now holds the selected person's DEAL id (see the
      // "People involved" picker). A personal task lives on that person's own
      // deal so the family view labels it with their name and scopes it to
      // their Purchase/Sale side. A shared task must live on the primary deal
      // (this view) so it fans out family-wide, exactly like auto-seeding does.
      const targetDealId = isShared ? deal.id : (taskForm.client || deal.id);
      const taskPayload = {
        deal_id: targetDealId,
        title: selectedTemplate?.name ?? taskForm.title,
        status: taskForm.status,
        due_date: taskForm.deadlineDate || null,
        assignee: taskForm.partner || null,
        task_template_id: selectedTemplate?.id ?? null,
        is_shared: isShared,
        milestone_id: taskForm.milestoneId || null,
        client: taskForm.client,
      };

      // Send POST request to API
      const response = await fetch("/api/admin/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskPayload),
      });

      // Parse JSON response
      const data = await response.json();

      if (data.success) {
        // Refetch through the same family GET the page uses so the new row is
        // annotated with owner_* and lands under the right person/side — it may
        // live on a co-client's deal, not the one currently in `tasks`. Fall
        // back to an optimistic append if the refetch fails.
        try {
          const refetched = await fetch(tasksFetchUrl).then((r) => r.json());
          if (Array.isArray(refetched)) setTasks(refetched.map(mapApiTask));
          else setTasks((prev) => [...prev, mapApiTask(data.data)]);
        } catch {
          setTasks((prev) => [...prev, mapApiTask(data.data)]);
        }

        // Reset form
        setShowTaskForm(false);
        setTaskForm({
          client: deal.id,
          partner: "",
          title: "",
          status: "Pending",
          deadlineDate: "",
          deadlineTime: "",
          milestoneId: "",
        });
      } else {
        alert("Failed to save task: " + data.error);
      }
    } catch (err) {
      console.error(err);
      alert("Error saving task.");
    }
  };

  const [showTaskForm, setShowTaskForm] = useState(false);

  const [taskForm, setTaskForm] = useState({
    // Holds the selected person's DEAL id; defaults to the current viewer.
    client: deal.id,
    partner: "",
    title: "",
    status: "Pending",
    deadlineDate: "",
    deadlineTime: "",
    milestoneId: "",
  });

  const handleTaskFormChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setTaskForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const [taskTemplates, setTaskTemplates] = useState<any[]>([]);
  // Templates the admin actively deleted on this deal in the current session.
  // The "default template" rendering in displayTasks treats any default
  // template with no matching user task as a ghost placeholder row — that's
  // intentional for *first-time* deals but a regression after a delete, when
  // we want the row to disappear cleanly. Tracked in memory only; reloading
  // restores the placeholder, which matches how default tasks normally seed.
  const [suppressedTemplateIds, setSuppressedTemplateIds] = useState<Set<string>>(new Set());
  const [taskFileDocs, setTaskFileDocs] = useState<any[]>([]);
  const [taskDocsPopup, setTaskDocsPopup] = useState<{ taskTitle: string; docs: any[]; isAps?: boolean } | null>(null);
  // file_url currently being deleted from the APS docs popup (drives the
  // per-row spinner / disabled state).
  const [deletingApsDocUrl, setDeletingApsDocUrl] = useState<string | null>(null);

  // Stage form state
  const [showStageForm, setShowStageForm] = useState(false);
  const [stageTemplates, setStageTemplates] = useState<any[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<any[]>([]);
  const [stageForm, setStageForm] = useState({
    stageTemplate: "",
    client: rawDeal?.client_id ?? "",
    status: "Pending",
    partner: "",
    milestoneDate: "",
    emailTemplateId: "",
  });

  const handleStageFormChange = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    const { name, value } = e.target;
    if (name === "stageTemplate") {
      const selected = stageTemplates.find(t => t.name === value);
      setStageForm((prev) => ({
        ...prev,
        stageTemplate: value,
        emailTemplateId: selected?.email_template_id ?? "",
      }));
    } else {
      setStageForm((prev) => ({ ...prev, [name]: value }));
    }
  };

  const handleSaveStage = async () => {
    if (!stageForm.stageTemplate) return;

    try {
      const payload = {
        deal_id: deal.id,
        title: stageForm.stageTemplate,
        status: stageForm.status,
        milestone_date: stageForm.milestoneDate || null,
        email_template_id: stageForm.emailTemplateId || null,
      };

      const res = await fetch("/api/admin/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (data.success) {
        // Resolve the side from the chosen stage template so the new row shows
        // on the correct Purchase/Sale tab immediately (a later GET re-derives
        // it from stage_templates.lead_type).
        const selectedStage = stageTemplates.find((t) => t.name === stageForm.stageTemplate) ?? null;
        const newMilestone: Milestone = {
          id: data.data.id,
          title: data.data.title,
          status: data.data.status ?? "Pending",
          milestoneDate: data.data.milestone_date ?? undefined,
          emailTemplateId: data.data.email_template_id ?? null,
          stageTemplateId: data.data.stage_template_id ?? null,
          leadType: selectedStage?.lead_type ?? null,
        };
        setMilestones((prev) => [...prev, newMilestone]);
        setShowStageForm(false);
        setStageForm({ stageTemplate: "", client: rawDeal?.client_id ?? "", status: "Pending", partner: "", milestoneDate: "", emailTemplateId: "" });
      } else {
        alert("Failed to save stage: " + data.error);
      }
    } catch (err) {
      console.error(err);
      alert("Error saving stage.");
    }
  };

  // Fetch user-added tasks from DB
  useEffect(() => {
    fetch(tasksFetchUrl)
      .then(res => res.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) setTasks(data.map(mapApiTask));
      })
      .catch(() => { });
  }, [tasksFetchUrl]);

  // Fetch user-added milestones from DB
  useEffect(() => {
    fetch(`/api/admin/milestones?deal_id=${deal.id}`)
      .then(res => res.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) {
          setMilestones(data.map((m: any): Milestone => ({
            id: m.id,
            title: m.title,
            status: m.status ?? "",
            milestoneDate: m.milestone_date ?? undefined,
            completedAt: m.completed_at ?? undefined,
            emailSent: m.email_sent ?? false,
            emailTemplateId: m.email_template_id ?? null,
            stageTemplateId: m.stage_template_id ?? null,
            leadType: m.stage_templates?.lead_type ?? null,
          })));
        }
      })
      .catch(() => { });
  }, [deal.id]);

  // Fetch task templates for predefined rows + add-task form
  useEffect(() => {
    fetch("/api/admin/task-templates")
      .then(res => res.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) setTaskTemplates(data);
      })
      .catch(() => { });
  }, []);

  // Fetch stage templates for predefined rows + add-stage form
  useEffect(() => {
    fetch("/api/admin/milestone-templates")
      .then(res => res.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) setStageTemplates(data);
      })
      .catch(() => { });
  }, []);

  // Combine predefined templates + user-added data for display (deduped by title)
  // A deal can be a combined type like "Purchase & Sale" — parse into individual parts
  // so templates from each constituent lead type are included and the rows can be tagged.
  // For co-leads of a combined parent, the parts are narrowed to just their side.
  const dealTypeParts = deriveDealTypeParts(deal.type, rawDeal?.current_deal_role);
  const dealTypePartsLower = dealTypeParts.map(s => s.toLowerCase());
  const isCombinedDealType = dealTypeParts.length > 1;

  // Build a stable {dealId → numbered role} map across the whole family.
  // Co-Purchasers/Co-Sellers/Co-Clients are numbered (Co-Purchaser 1,
  // Co-Purchaser 2, …) sorted alphabetically by lead name so the
  // numbering is the same on every page render. Primary roles aren't
  // numbered. Used for the top-right indicator on the Property card
  // and inside the People involved card so both surfaces agree.
  const numberedRoles = (() => {
    type Member = { id: string; role: string; lead_name: string };
    const currentRole = (rawDeal?.current_deal_role as string | undefined) ?? "";
    const currentName = [
      rawDeal?.lead_first_name,
      rawDeal?.lead_last_name,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    const members: Member[] = [
      { id: deal.id, role: currentRole, lead_name: currentName },
      ...((rawDeal?.linked_deals as any[]) ?? []).map((ld) => ({
        id: ld.id as string,
        role: (ld.role as string) ?? "",
        lead_name: (ld.lead_name as string) ?? "",
      })),
    ];
    const groups = new Map<string, Member[]>();
    for (const m of members) {
      if (!m.role) continue;
      const g = groups.get(m.role) ?? [];
      g.push(m);
      groups.set(m.role, g);
    }
    const byDealId = new Map<string, string>();
    for (const [role, group] of groups.entries()) {
      const isPrimaryRole = role.toLowerCase().startsWith("primary");
      if (isPrimaryRole || group.length <= 1) {
        // Single occurrence or Primary → no number needed.
        for (const m of group) byDealId.set(m.id, role);
        continue;
      }
      const sorted = [...group].sort((a, b) =>
        a.lead_name.localeCompare(b.lead_name, undefined, { sensitivity: "base" }),
      );
      sorted.forEach((m, idx) => byDealId.set(m.id, `${role} ${idx + 1}`));
    }
    return {
      current: byDealId.get(deal.id) ?? currentRole,
      byDealId,
    };
  })();

  // The whole family (current viewer + linked co-purchasers/co-sellers) as a
  // single sorted list. Lifted to the component body so both the "People
  // involved" card and the dedicated "Identification Documents" card render
  // from the same source of truth.
  type FamilyPerson = {
    id: string;
    lead_id: string | null;
    lead_name: string;
    lead_email: string;
    lead_phone: string;
    role: string;
    file_number: string;
    property_address: string;
    selling_property_address: string;
    status: string;
    accountCreated: boolean;
    isCurrent: boolean;
    identificationTaskId: string | null;
    identificationStatus: string | null;
    /** True for the family's designated document uploader (resolved from the
     *  primary's upload_mode by the deals API). */
    canUploadForAll: boolean;
  };
  const familyPeople: FamilyPerson[] = (() => {
    const currentName = [rawDeal?.lead_first_name, rawDeal?.lead_last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    const currentEntry: FamilyPerson = {
      id: deal.id,
      lead_id: primaryLeadId,
      lead_name: currentName || "Current viewer",
      lead_email: (rawDeal?.lead_email as string | null) || "",
      lead_phone:
        (primaryLeadId ? phoneOverrides[primaryLeadId] : undefined) ??
        ((rawDeal?.lead_phone as string | null) || ""),
      role: numberedRoles.byDealId.get(deal.id) || rawDeal?.current_deal_role || "Primary",
      file_number: deal.fileNumber,
      property_address: deal.propertyAddress || "",
      selling_property_address: ((deal as any).sellingPropertyAddress as string | undefined) || "",
      status: deal.status,
      accountCreated: !!rawDeal?.account_created_at,
      isCurrent: true,
      identificationTaskId: (rawDeal?.identification_task_id as string | null) ?? null,
      identificationStatus: (rawDeal?.identification_status as string | null) ?? null,
      canUploadForAll: (rawDeal as any)?.can_upload_for_all === true,
    };
    const linked: FamilyPerson[] = ((rawDeal?.linked_deals ?? []) as any[]).map((ld) => ({
      id: ld.id,
      lead_id: (ld.lead_id as string | null) ?? null,
      lead_name: ld.lead_name || "Unknown",
      lead_email: ld.lead_email || "",
      lead_phone:
        (ld.lead_id ? phoneOverrides[ld.lead_id as string] : undefined) ??
        (ld.lead_phone || ""),
      role: numberedRoles.byDealId.get(ld.id) || ld.role || "Co-Client",
      file_number: ld.file_number || "",
      property_address: ld.property_address || "",
      selling_property_address: (ld.selling_property_address as string | null) ?? "",
      status: ld.status || "Active",
      accountCreated: !!ld.account_created_at,
      isCurrent: false,
      identificationTaskId: (ld.identification_task_id as string | null) ?? null,
      identificationStatus: (ld.identification_status as string | null) ?? null,
      canUploadForAll: ld.can_upload_for_all === true,
    }));
    const sortKey = (p: FamilyPerson) => {
      const r = p.role.toLowerCase();
      if (r.startsWith("primary")) return 0;
      if (r.includes("co-purchaser")) return 1;
      if (r.includes("co-seller")) return 2;
      return 3;
    };
    return [currentEntry, ...linked].sort((a, b) => sortKey(a) - sortKey(b));
  })();

  // The family's designated document uploader (the person flagged
  // can_upload_for_all by the deals API), or null when everyone uploads their
  // own ('both'/unset). Drives the per-person upload badge below.
  const familyUploader = familyPeople.find((p) => p.canUploadForAll) ?? null;

  // Retainer-signed status per person, keyed by lead_id. Reuses the same
  // endpoint the Leads "Send Email" modal uses; `signed` there means a row
  // exists in retainer_signatures, which is the source of truth that the client
  // actually signed (the generated PDF is a separate, async step and is NOT
  // required for the badge to read "signed").
  //
  // A lead_id is absent from this map until the fetch resolves, which is what
  // gates the badge below — rendering an empty map as "not signed" would
  // briefly libel every person on the file.
  const [retainerSigned, setRetainerSigned] = useState<Record<string, boolean>>({});
  const familyLeadIdsKey = familyPeople
    .map((p) => p.lead_id)
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    if (!familyLeadIdsKey) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/retainer-status?lead_ids=${encodeURIComponent(familyLeadIdsKey)}`,
        );
        const data = await res.json();
        if (cancelled || !data?.success || !data.status) return;
        setRetainerSigned(
          Object.fromEntries(
            Object.entries(
              data.status as Record<string, { signed?: boolean }>,
            ).map(([leadId, s]) => [leadId, s?.signed === true]),
          ),
        );
      } catch {
        // Non-blocking — on failure the badge simply doesn't render.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [familyLeadIdsKey]);

  // Whose Personal Information this is. The client portal shows Full Name as a
  // read-only field at the top of that task, sourced from the client record
  // rather than task_form_fields — so it has no response row and would
  // otherwise be invisible here. Prefer the task's own owner (family view lists
  // one row per person), else the current lead.
  const personalInfoFullName = (task: DisplayTask): string | null => {
    const owner =
      [task.ownerFirstName, task.ownerLastName].filter(Boolean).join(" ").trim() ||
      (task.ownerName ?? "").trim();
    if (owner) return owner;
    const current = familyPeople.find((p) => p.isCurrent)?.lead_name;
    if (current) return current;
    const lead = [rawDeal?.lead_first_name, rawDeal?.lead_last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    return lead || null;
  };

  // The lead whose name the Personal Information task's Full Name belongs to,
  // split into the parts /api/admin/leads expects. Resolution mirrors
  // personalInfoFullName: the task's own owner first (the family view lists one
  // row per person), else the deal's own lead — so an admin editing a
  // co-purchaser's task renames THAT person, not the primary.
  const personalInfoNameTarget = (
    task: DisplayTask,
  ): { leadId: string; first: string; last: string } | null => {
    if (task.ownerLeadId) {
      return {
        leadId: task.ownerLeadId,
        first: task.ownerFirstName ?? "",
        last: task.ownerLastName ?? "",
      };
    }
    const leadId = (rawDeal?.lead_id as string | null) ?? null;
    if (!leadId) return null;
    return {
      leadId,
      first: (rawDeal?.lead_first_name as string | null) ?? "",
      last: (rawDeal?.lead_last_name as string | null) ?? "",
    };
  };

  // Map each person's deal id → the workflow side their role belongs to, used
  // in the unified family view to scope a co-client's PERSONAL rows (Personal
  // Information / Identification, which carry no template lead_type) to the
  // correct tab. A co-purchaser only acts on Purchase, a co-seller only on
  // Sale, so their personal rows must not leak onto the other tab. The primary
  // acts on both sides, so they're intentionally left unscoped (their personal
  // rows show on every tab).
  const ownerDealSide = (() => {
    const m = new Map<string, "Purchase" | "Sale">();
    for (const p of familyPeople) {
      const r = p.role.toLowerCase();
      if (r.startsWith("primary")) continue;
      if (r.includes("co-purchaser")) m.set(p.id, "Purchase");
      else if (r.includes("co-seller")) m.set(p.id, "Sale");
    }
    return m;
  })();

  const roleChipClass = (role: string) => {
    const r = role.toLowerCase();
    if (r.startsWith("primary")) return "bg-green-100 text-green-700 border-green-200";
    if (r.includes("co-seller")) return "bg-orange-100 text-orange-700 border-orange-200";
    return "bg-blue-100 text-blue-700 border-blue-200";
  };

  // Impersonate any person in the family (primary, co-purchaser, co-seller)
  // by their email. Reuses the existing /api/admin/impersonate endpoint, which
  // resolves the email to a Supabase magic link and never emails the client.
  // Gated on accountCreated at the call site — generateLink only works once the
  // person has an auth account.
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const handleImpersonate = async (person: FamilyPerson) => {
    if (!person.accountCreated || !person.lead_email) {
      showToast("This client has not signed in yet — cannot impersonate.", "error");
      return;
    }
    // SEC-006 step-up: re-confirm the admin's own password before impersonating.
    const stepUpPassword = window.prompt(
      "Security check: re-enter YOUR admin password to log in as this client.",
    );
    if (!stepUpPassword) return;
    setImpersonatingId(person.id);
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: person.lead_email, stepUpPassword }),
      });
      const json = await res.json();
      if (!res.ok || !json.url) {
        throw new Error(json.error || "Failed to generate link");
      }
      window.open(json.url, "_blank", "noopener,noreferrer");
    } catch (err: any) {
      console.error("Impersonate error:", err);
      showToast(`Failed to impersonate: ${err?.message ?? "unknown error"}`, "error");
    } finally {
      setImpersonatingId(null);
    }
  };

  // Begin inline phone edit for a person. Pre-fills the draft with the current
  // (formatted) number. Only available when the person has a lead_id to write to.
  const beginEditPhone = (person: FamilyPerson) => {
    if (!person.lead_id) return;
    setEditingPhoneLeadId(person.lead_id);
    setPhoneDraft(person.lead_phone || "");
  };

  const cancelEditPhone = () => {
    setEditingPhoneLeadId(null);
    setPhoneDraft("");
  };

  // Persist a person's phone to their lead row via the existing leads PUT.
  // An empty value clears the number; a non-empty one must have ≥10 digits
  // (matching the task-form phone validation). On success we stash the saved
  // value in phoneOverrides so the row updates without a full refetch.
  const handleSavePhone = async (person: FamilyPerson) => {
    if (!person.lead_id) {
      showToast("Cannot edit phone: missing lead reference.", "error");
      return;
    }
    const formatted = formatPhoneAsTyped(phoneDraft);
    const digits = formatted.replace(/\D/g, "");
    if (formatted && digits.length < 10) {
      showToast("Phone number must have at least 10 digits.", "error");
      return;
    }
    setSavingPhoneId(person.id);
    try {
      const res = await fetch("/api/admin/leads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: person.lead_id, phone: formatted }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to update phone");
      }
      setPhoneOverrides((prev) => ({ ...prev, [person.lead_id as string]: formatted }));
      cancelEditPhone();
      showToast("Phone number updated");
    } catch (err: any) {
      showToast(err?.message ?? "Failed to update phone", "error");
    } finally {
      setSavingPhoneId(null);
    }
  };

  // True when the task currently open in the Edit Task modal is an APS task.
  // Resolved from the task templates list so the modal can offer the APS
  // upload/replace action only where it applies.
  const isEditingApsTask = !!(
    editingTask?.taskTemplateId &&
    (taskTemplates as any[]).find((t) => t.id === editingTask.taskTemplateId)?.is_aps_task
  );

  // template id → lead_type lookups (used to resolve a task/milestone's source lead type)
  const taskTemplateLeadTypeMap = new Map<string, string>(
    (taskTemplates as any[]).map(t => [t.id, t.lead_type])
  );

  // task-template id → the stage (milestone) it belongs to. Lets us map a
  // per-person personal task back to its milestone STAGE without the owner
  // deal's milestone rows: a co-person's task only carries its own deal's
  // milestone_id (not the primary's), but the task_template's stage_template_id
  // is the family-stable key. Used to split personal-task milestones per person.
  const taskTemplateStageMap = new Map<string, string>(
    (taskTemplates as any[])
      .filter(t => t.stage_template_id)
      .map(t => [t.id, t.stage_template_id as string]),
  );

  // Match uploaded file docs to a task row, in priority order:
  //   1. exact task_id (personal tasks / primary view of shared)
  //   2. shared_task_key === taskTemplateId (cross-family shared docs)
  //   3. fallback: doc's task_title matches task.title (legacy bridged docs)
  // Side-aware: a Purchase-side doc never surfaces under the Sale-side row
  // (and vice-versa) even when the two share a template-derived title.
  // Shared by the Doc column and the Actions download button so they always
  // agree on which files belong to a task.
  const getTaskFileDocs = (task: DisplayTask): any[] => {
    return taskFileDocs.filter((d: any) => {
      if (d.task_id === task.id) return true;
      const docLeadType = d.shared_task_key
        ? taskTemplateLeadTypeMap.get(d.shared_task_key) ?? null
        : null;
      if (
        docLeadType &&
        task.leadType &&
        docLeadType.toLowerCase() !== task.leadType.toLowerCase()
      ) {
        return false;
      }
      if (
        task.taskTemplateId &&
        d.shared_task_key &&
        d.shared_task_key === task.taskTemplateId
      ) {
        return true;
      }
      // Legacy title fallback — ONLY for docs with no owning task_id. Every
      // task_responses row carries a real task_id (matched by rule 1 above), so
      // without this guard a doc would also match any OTHER task that happens to
      // share the same stored title. That's exactly the per-person case:
      // "Upload Identification" / "Provide Personal Information" store the same
      // title on every family member's task (the "- Name" suffix is UI-only), so
      // one person's uploaded docs would wrongly inflate another person's Doc
      // count. Restricting to unlinked docs keeps the bridge for truly orphaned
      // rows while scoping real docs to their own person via rule 1.
      if (
        !d.task_id &&
        d.field_type === "file" &&
        d.task_title &&
        task.title &&
        d.task_title.trim().toLowerCase() === task.title.trim().toLowerCase()
      ) {
        return true;
      }
      return false;
    });
  };

  // Download a single stored file. Fetch-then-blob so cross-origin storage
  // URLs (Vercel Blob, S3) actually download instead of navigating away;
  // falls back to a plain anchor click if fetch is blocked by CORS.
  const downloadDocFile = async (doc: any): Promise<void> => {
    if (!doc?.file_url) return;
    // Private docs stream through the same-origin auth-gated proxy (needs the
    // session cookie); public/legacy blobs are fetched directly with no creds.
    const href = docDownloadHref(doc.file_url);
    try {
      const res = await fetch(href, {
        credentials: docFetchCredentials(doc.file_url),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = doc.file_name || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      const a = document.createElement("a");
      a.href = href;
      a.download = doc.file_name || "download";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  // Resolve which lead type (Purchase / Sale) a document belongs to, from the
  // owning task's source template. Used in the View Documents modal so every
  // uploaded document — not just APS — is tagged with its side. Tasks whose
  // template has no lead type (generic / manually-added) return null and stay
  // unbadged. Falls back to `shared_task_key` for older payloads that predate
  // the explicit `task_template_id` field.
  const docSide = (doc: any): string | null => {
    const key = doc?.task_template_id ?? doc?.shared_task_key;
    if (!key) return null;
    const lt = taskTemplateLeadTypeMap.get(key);
    if (!lt) return null;
    const n = lt.toLowerCase();
    return n === "purchase" ? "Purchase" : n === "sale" ? "Sale" : null;
  };
  const stageTemplateLeadTypeMap = new Map<string, string>(
    (stageTemplates as any[]).map(t => [t.id, t.lead_type])
  );

  const matchesDealType = (templateLeadType: string | undefined): boolean => {
    if (!dealTypePartsLower.length) return true;
    const lt = templateLeadType?.toLowerCase();
    return !!lt && dealTypePartsLower.includes(lt);
  };

  // Filter rows by an active tab (one of the lead-type parts). Items without a
  // resolved leadType (e.g. manually-added tasks) appear in every tab so they
  // are never hidden by the filter.
  const matchesActiveTab = (
    rowLeadType: string | null | undefined,
    activeTab: string,
  ): boolean => {
    if (!rowLeadType) return true;
    return rowLeadType.toLowerCase() === activeTab.toLowerCase();
  };

  const dedupeTasksByTemplate = (rows: Task[]) => {
    const seen = new Set<string>();
    return rows.filter((task) => {
      if (!task.taskTemplateId) return true;
      // In the unified family view each person has their own row for the same
      // personal template (ID / Personal Information). Key those by template +
      // owner deal so they aren't collapsed into one; shared rows still dedupe
      // by template id alone.
      const key = task.ownerDealId
        ? `${task.taskTemplateId}:${task.ownerDealId}`
        : task.taskTemplateId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const dedupeMilestonesByTemplate = (rows: Milestone[]) => {
    const seen = new Set<string>();
    return rows.filter((milestone) => {
      if (!milestone.stageTemplateId) return true;
      if (seen.has(milestone.stageTemplateId)) return false;
      seen.add(milestone.stageTemplateId);
      return true;
    });
  };

  // Strict per-tab filtering for combined deals: each row appears on the tab
  // matching its source template's lead_type. No item is duplicated across
  // tabs. (Manually-added rows with no lead_type still appear on every tab so
  // they aren't hidden.)
  const displayTasks: DisplayTask[] = (() => {
    const dedupedTasks = dedupeTasksByTemplate(tasks);
    const userTitles = new Set(dedupedTasks.map(t => t.title.toLowerCase()));
    // Template ids already instantiated as a real task on this deal. Matching
    // by id (not just title) means a renamed template still resolves to its
    // existing task instead of resurfacing as a phantom "Pending" ghost row.
    const userTemplateIds = new Set(
      dedupedTasks.map(t => t.taskTemplateId).filter(Boolean) as string[],
    );
    const templateRows: DisplayTask[] = (taskTemplates as any[])
      .filter(t => t.is_default)
      .filter(t => matchesDealType(t.lead_type))
      .filter(t => !userTemplateIds.has(t.id))
      .filter(t => !userTitles.has(t.name.toLowerCase()))
      .filter(t => !suppressedTemplateIds.has(t.id))
      .map((t): DisplayTask => ({
        id: `tpl-${t.id}`,
        title: t.name,
        completed: false,
        status: "Pending",
        isTemplate: true,
        taskTemplateId: t.id,
        leadType: t.lead_type ?? null,
        orderIndex: t.order_index ?? null,
      }));
    const userRows: DisplayTask[] = dedupedTasks.flatMap(t => {
      // In the unified family view, scope each co-client's PERSONAL rows to the
      // single side their role acts on. A co-purchaser only deals on Purchase,
      // a co-seller only on Sale, so for a co-client row we:
      //   • DROP it when its template lead_type is the OTHER side — e.g. a
      //     Sale-side Personal Info/ID mis-seeded onto a co-purchaser's deal
      //     (happens when the co-lead inherited a combined "Purchase & Sale"
      //     lead_type); such a row doesn't belong to that person at all.
      //   • PIN a row that has no template lead_type to the co-client's own side
      //     so it lands on the correct tab instead of every tab.
      // The primary acts on both sides, so their rows are left untouched.
      const ownerSide =
        includeFamilyTasks && t.ownerDealId ? ownerDealSide.get(t.ownerDealId) : undefined;
      const rawLeadType =
        t.leadType
        ?? (t.taskTemplateId ? taskTemplateLeadTypeMap.get(t.taskTemplateId) ?? null : null);
      if (ownerSide) {
        if (rawLeadType && rawLeadType.toLowerCase() !== ownerSide.toLowerCase()) {
          return [];
        }
        return [{ ...t, isTemplate: false, leadType: ownerSide }];
      }
      return [{ ...t, isTemplate: false, leadType: rawLeadType }];
    });
    // Sort by order_index (the per-deal task sequence, kept in sync with the
    // template order and editable via the drag handles). Rows without an order
    // fall to the end; stable sort keeps ghost-before-real for equal indexes.
    const all = [...templateRows, ...userRows].sort(
      (a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER),
    );
    if (isCombinedDealType) {
      return all.filter(t => matchesActiveTab(t.leadType, activeTaskTab));
    }
    // Single-type deals: shared tasks come from the primary deal (which may be
    // a combined Purchase & Sale deal), so apply the same filter — only show
    // tasks whose leadType matches the deal's type, or have no leadType.
    return all.filter(t => !t.leadType || matchesDealType(t.leadType));
  })();

  const displayMilestones: DisplayMilestone[] = (() => {
    const dedupedMilestones = dedupeMilestonesByTemplate(milestones);
    const userTitles = new Set(dedupedMilestones.map(m => m.title.toLowerCase()));
    // Stage-template ids already instantiated as a real milestone on this deal.
    // Matching by id (not just title) means a renamed stage template still
    // resolves to its existing milestone instead of resurfacing as a phantom
    // "Pending" ghost row.
    const userStageTemplateIds = new Set(
      dedupedMilestones.map(m => m.stageTemplateId).filter(Boolean) as string[],
    );
    const templateRows: DisplayMilestone[] = (stageTemplates as any[])
      .filter(t => matchesDealType(t.lead_type))
      .filter(t => !userStageTemplateIds.has(t.id))
      .filter(t => !userTitles.has(t.name.toLowerCase()))
      .map((t): DisplayMilestone => ({
        id: `tpl-${t.id}`,
        title: t.name,
        status: "Pending",
        isTemplate: true,
        emailTemplateId: t.email_template_id ?? null,
        stageTemplateId: t.id,
        leadType: t.lead_type ?? null,
        orderIndex: t.order_index ?? null,
      }));
    const userRows: DisplayMilestone[] = dedupedMilestones.map(m => ({
      ...m,
      isTemplate: false,
      leadType:
        m.leadType
        ?? (m.stageTemplateId ? stageTemplateLeadTypeMap.get(m.stageTemplateId) ?? null : null),
    }));
    // Sort by order_index (the canonical stage sequence; drag handles persist a
    // per-deal override). Rows without an order fall to the end.
    const all = [...templateRows, ...userRows].sort(
      (a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER),
    );

    // Family view: split a personal-task stage (e.g. Personal Information /
    // Identification) into ONE row per person, mirroring how the task list
    // already shows "<task> - <name>" per person. We synthesise these rows from
    // the per-person personal TASKS (which carry owner + status) keyed to their
    // stage via the task-template→stage map — the co-person's own milestone rows
    // aren't fetched here, but the primary's stage row + each person's task
    // progress is all we need. Shared/deal-level stages are left as a single row.
    // Derived from displayTasks so the same side-scoping + active tab apply.
    const splitAll: DisplayMilestone[] = (() => {
      if (!includeFamilyTasks) return all;

      // stage_template_id → (ownerDealId → { name, task statuses })
      const stageOwners = new Map<string, Map<string, { name: string; statuses: string[] }>>();
      for (const t of displayTasks) {
        if (t.isTemplate || !t.ownerDealId || !t.taskTemplateId) continue;
        const stageId = taskTemplateStageMap.get(t.taskTemplateId);
        if (!stageId) continue;
        const owners = stageOwners.get(stageId) ?? new Map();
        const entry = owners.get(t.ownerDealId) ?? { name: t.ownerName ?? "", statuses: [] };
        entry.statuses.push(t.status || "Pending");
        if (t.ownerName) entry.name = t.ownerName;
        owners.set(t.ownerDealId, entry);
        stageOwners.set(stageId, owners);
      }
      if (stageOwners.size === 0) return all;

      // A person's progress for a stage: Completed only if all their tasks in it
      // are done; else Pending.
      const ownerStatus = (statuses: string[]): Milestone["status"] => {
        if (statuses.length === 0) return "Pending";
        if (statuses.every((s) => s === "Completed")) return "Completed";
        return "Pending";
      };

      return all.flatMap((m) => {
        if (m.isTemplate || !m.stageTemplateId) return [m];
        const owners = stageOwners.get(m.stageTemplateId);
        if (!owners || owners.size === 0) return [m];
        // Collapse to ONE row for the stage with an aggregate "X of N people
        // done" badge (instead of one row per person). Status is derived:
        // Completed only once every party is done, otherwise Pending.
        const infos = Array.from(owners.values());
        const total = infos.length;
        const completed = infos.filter((info) => ownerStatus(info.statuses) === "Completed").length;
        return [{
          ...m,
          status: (total > 0 && completed === total ? "Completed" : "Pending") as Milestone["status"],
          personalProgress: { completed, total },
        }];
      });
    })();

    if (isCombinedDealType) {
      return splitAll.filter(m => matchesActiveTab(m.leadType, activeMilestoneTab));
    }
    return splitAll.filter(m => !m.leadType || matchesDealType(m.leadType));
  })();

  useEffect(() => {
    fetch("/api/admin/email-templates")
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setEmailTemplates(data); })
      .catch(() => { });
  }, []);


  const fetchTaskFileDocs = async () => {
    try {
      const res = await fetch(`/api/admin/task-responses?deal_id=${deal.id}${includeFamilyTasks ? "&include_family=1" : ""}`);
      const data = await res.json();
      if (Array.isArray(data)) setTaskFileDocs(data);
    } catch { }
  };
  useEffect(() => {
    fetchTaskFileDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal.id, includeFamilyTasks]);

  // All client responses (text + file) for the deal, grouped by task id. Powers
  // the PDF export — both the per-task button (so it can show the personal-info
  // fields, not just files) and the global "Download All" report. `fields=all`
  // lifts the file-only filter the View Documents modal relies on. Shared-task
  // rows come back keyed to the primary deal's task id, which is exactly what
  // displayTasks uses, so the map lines up by task.id.
  const [responsesByTask, setResponsesByTask] = useState<Map<string, any[]>>(new Map());
  const [downloadingDealPdf, setDownloadingDealPdf] = useState(false);
  const [downloadingTaskId, setDownloadingTaskId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/task-responses?deal_id=${deal.id}&fields=all${includeFamilyTasks ? "&include_family=1" : ""}`);
        const data = await res.json();
        if (cancelled || !Array.isArray(data)) return;
        const grouped = new Map<string, any[]>();
        for (const r of data) {
          const key = r.task_id as string;
          if (!key) continue;
          const arr = grouped.get(key) ?? [];
          arr.push(r);
          grouped.set(key, arr);
        }
        setResponsesByTask(grouped);
      } catch { }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal.id, includeFamilyTasks]);

  // Does this task have any downloadable data (client responses or files)?
  // Drives whether the per-task PDF button is shown.
  const taskHasData = (task: DisplayTask): boolean => {
    if (task.isTemplate) return false;
    return (responsesByTask.get(task.id)?.length ?? 0) > 0 || getTaskFileDocs(task).length > 0;
  };

  // Deal-level metadata reused by both PDF entry points.
  const buildPdfDealMeta = (): PdfDealMeta => ({
    fileNumber: deal.fileNumber,
    type: deal.type,
    status: deal.status,
    propertyAddress: deal.propertyAddress || "",
    sellingPropertyAddress: ((deal as any).sellingPropertyAddress as string | undefined) || "",
    closingDate: deal.closingDate ? formatLocalDate(deal.closingDate) : "",
    price: (deal as any).price ?? null,
    people: familyPeople.map((p) => ({
      name: p.lead_name,
      role: p.role,
      email: p.lead_email,
      phone: p.lead_phone,
    })),
  });

  const templateFieldOrderCache = useRef(new Map<string, Promise<Map<string, number> | null>>());

  const getTemplateFieldOrder = async (taskTemplateId: string | null) => {
    if (!taskTemplateId) return null;
    const cached = templateFieldOrderCache.current.get(taskTemplateId);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const res = await fetch(`/api/admin/task-form-fields?task_template_id=${encodeURIComponent(taskTemplateId)}`);
        if (!res.ok) return null;
        const fieldsData = await res.json();
        if (!Array.isArray(fieldsData)) return null;

        const orderByFieldId = new Map<string, number>();
        const orderByFieldLabel = new Map<string, number>();
        fieldsData.forEach((f: any, index: number) => {
          const fieldId = f?.id ? String(f.id) : "";
          const fieldLabel = (f?.label ?? "").trim().toLowerCase();
          const order = Number(f?.order_index ?? index);
          if (fieldId) orderByFieldId.set(fieldId, order);
          if (fieldLabel) orderByFieldLabel.set(fieldLabel, order);
        });

        return new Map<string, number>([...orderByFieldId.entries(), ...orderByFieldLabel.entries()]);
      } catch {
        return null;
      }
    })();

    templateFieldOrderCache.current.set(taskTemplateId, promise);
    return promise;
  };

  const sortResponsesByFormOrder = async (task: DisplayTask, responses: any[]) => {
    if (!Array.isArray(responses) || responses.length === 0) return responses;

    const templateOrder = await getTemplateFieldOrder(task.taskTemplateId ?? null);
    if (!templateOrder || templateOrder.size === 0) return responses;

    return [...responses].sort((a, b) => {
      const aOrder = a?.field_id
        ? (templateOrder.get(String(a.field_id)) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
      const bOrder = b?.field_id
        ? (templateOrder.get(String(b.field_id)) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;

      if (aOrder !== bOrder) return aOrder - bOrder;

      const aLabel = String(a?.field_label ?? a?.field_id ?? "").toLowerCase();
      const bLabel = String(b?.field_label ?? b?.field_id ?? "").toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  };

  // Merge responses (text + file) for a task, deduping file rows that also
  // surface via taskFileDocs (e.g. APS) so a document isn't embedded twice.
  // Fetch the freshest task responses for this deal (incl. family) so a PDF
  // download reflects edits saved AFTER the page loaded — e.g. a co-person's
  // Business/Employer Phone entered in the Personal Information modal. Returns
  // a task_id → responses map, or null on failure (caller falls back to state).
  const fetchFreshResponsesMap = async (): Promise<Map<string, any[]> | null> => {
    try {
      const res = await fetch(
        `/api/admin/task-responses?deal_id=${deal.id}&fields=all${includeFamilyTasks ? "&include_family=1" : ""}`,
      );
      const data = await res.json();
      if (!Array.isArray(data)) return null;
      const grouped = new Map<string, any[]>();
      for (const r of data) {
        const key = r.task_id as string;
        if (!key) continue;
        const arr = grouped.get(key) ?? [];
        arr.push(r);
        grouped.set(key, arr);
      }
      return grouped;
    } catch {
      return null;
    }
  };

  const buildPdfTaskInput = async (
    task: DisplayTask,
    respMap?: Map<string, any[]>,
  ): Promise<PdfTaskInput> => {
    const source = respMap ?? responsesByTask;
    const responses = [...(source.get(task.id) ?? [])];
    const seenFileUrls = new Set(
      responses.filter((r) => r.field_type === "file" && r.file_url).map((r) => r.file_url),
    );
    for (const d of getTaskFileDocs(task)) {
      if (d.field_type === "file" && d.file_url && !seenFileUrls.has(d.file_url)) {
        responses.push(d);
        seenFileUrls.add(d.file_url);
      }
    }

    const orderedResponses = await sortResponsesByFormOrder(task, responses);

    // "Business/Employer Phone" is optional in the intake form, so a client who
    // leaves it blank produces no response row and it silently drops out of the
    // Personal Information PDF. Personal fields live on the client record (the
    // source of truth), surfaced here as rawDeal.lead_employer_phone for THIS
    // deal's own person. When there's no response for it but the client record
    // has a value, inject the row so the PDF isn't missing the number. Only for
    // the current person — co-persons' employer phone isn't available here, and
    // we must not print the wrong person's number.
    const finalResponses = [...orderedResponses];
    if (isPersonalInfoTask(task)) {
      const hasEmployerPhone = finalResponses.some(
        (r) =>
          /(employer|business)/i.test(r.field_label ?? "") && /phone/i.test(r.field_label ?? ""),
      );
      const currentName = familyPeople.find((p) => p.isCurrent)?.lead_name ?? null;
      const isCurrentPerson = !task.ownerName || task.ownerName === currentName;
      const employerPhone = ((rawDeal?.lead_employer_phone as string | null | undefined) ?? "").trim();
      if (!hasEmployerPhone && isCurrentPerson && employerPhone) {
        const empRow = {
          field_id: null,
          field_label: "Business/Employer Phone",
          field_type: "text",
          value: employerPhone,
        };
        // Place it right after Occupation (its natural neighbour); append if
        // there's no occupation row.
        const occIdx = finalResponses.findIndex((r) => /occupation/i.test(r.field_label ?? ""));
        if (occIdx >= 0) finalResponses.splice(occIdx + 1, 0, empRow);
        else finalResponses.push(empRow);
      }
    }

    return {
      title: task.title,
      status: task.status ?? "Pending",
      leadType: task.leadType ?? null,
      milestoneTitle: task.milestoneId
        ? milestones.find((m) => m.id === task.milestoneId)?.title ?? null
        : null,
      dueDate: task.dueDate ? formatLocalDate(task.dueDate) : null,
      completedAt: task.completedAt ? formatLocalDateTime(task.completedAt) : null,
      // Per-person tasks (Personal Information / Upload ID) carry the person's
      // name in the PDF heading, a "Name" row, and the file name. Family deals
      // supply task.ownerName; single-person deals fall back to this deal's own
      // client name. Other tasks stay name-less.
      ownerName:
        task.ownerName ??
        ((isPersonalInfoTask(task) || isIdentificationTask(task))
          ? familyPeople.find((p) => p.isCurrent)?.lead_name || null
          : null),
      responses: finalResponses,
    };
  };

  const handleDownloadTaskPdf = async (task: DisplayTask) => {
    setDownloadingTaskId(task.id);
    try {
      // Pull the latest responses so a just-saved value (e.g. a co-person's
      // employer phone) is included even without a page refresh.
      const fresh = await fetchFreshResponsesMap();
      if (fresh) setResponsesByTask(fresh);
      const taskInput = await buildPdfTaskInput(task, fresh ?? undefined);
      await downloadTaskPdf(buildPdfDealMeta(), taskInput);
    } catch {
      showToast("Could not generate the task PDF", "error");
    } finally {
      setDownloadingTaskId(null);
    }
  };

  // Global export: only tasks that actually have data (client responses or
  // uploaded documents), grouped by milestone, with all personal info +
  // uploaded documents embedded. Empty tasks are excluded — same rule as the
  // per-task download button.
  const handleDownloadDealPdf = async () => {
    setDownloadingDealPdf(true);
    try {
      // Freshest responses so recently-saved edits are included.
      const fresh = await fetchFreshResponsesMap();
      if (fresh) setResponsesByTask(fresh);
      const realTasks = dedupeTasksByTemplate(tasks).filter((t) =>
        taskHasData({ ...t, isTemplate: false }),
      );
      const milestoneOrder = (m: Milestone) => m.orderIndex ?? Number.MAX_SAFE_INTEGER;
      const orderedMilestones = [...milestones].sort((a, b) => milestoneOrder(a) - milestoneOrder(b));
      const sections: PdfDealSection[] = [];
      const usedTaskIds = new Set<string>();
      for (const m of orderedMilestones) {
        const milestoneTasks = realTasks
          .filter((t) => t.milestoneId === m.id)
          .sort((a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER));
        if (milestoneTasks.length === 0) continue;
        milestoneTasks.forEach((t) => usedTaskIds.add(t.id));
        const builtTasks = await Promise.all(
          milestoneTasks.map((t) => buildPdfTaskInput({ ...t, isTemplate: false }, fresh ?? undefined)),
        );
        sections.push({
          milestoneTitle: m.title,
          leadType: m.leadType ?? null,
          tasks: builtTasks,
        });
      }
      // Tasks not attached to any milestone (manually-added / unlinked).
      const orphanTasks = realTasks.filter((t) => !usedTaskIds.has(t.id));
      if (orphanTasks.length > 0) {
        const builtOrphanTasks = await Promise.all(
          orphanTasks.map((t) => buildPdfTaskInput({ ...t, isTemplate: false }, fresh ?? undefined)),
        );
        sections.push({
          milestoneTitle: "Other Tasks",
          tasks: builtOrphanTasks,
        });
      }
      if (sections.length === 0) {
        showToast("No tasks to download for this deal", "error");
        return;
      }
      await downloadDealPdf(buildPdfDealMeta(), sections);
    } catch {
      showToast("Could not generate the deal PDF", "error");
    } finally {
      setDownloadingDealPdf(false);
    }
  };

  const [leadCorporateDocs, setLeadCorporateDocs] = useState<any[]>([]);
  const fetchLeadCorporateDocs = async () => {
    try {
      const res = await fetch(`/api/admin/lead-docs?deal_id=${deal.id}`);
      const data = await res.json();
      if (Array.isArray(data)) setLeadCorporateDocs(data);
    } catch { }
  };
  useEffect(() => {
    fetchLeadCorporateDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal.id]);

  const findIdMeta = (doc: { file_name?: string | null; file_url?: string | null; value?: string | null } | null | undefined) => {
    if (!doc) return null;
    const match =
      (doc.file_name && leadCorporateDocs.find(r => r.file_name === doc.file_name)) ||
      (doc.file_url && leadCorporateDocs.find(r => r.file_url === doc.file_url)) ||
      (doc.value && leadCorporateDocs.find(r => r.file_name === doc.value)) ||
      null;
    return match && match.doc_type === 'identification' ? match : null;
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-6 right-6 z-50 px-5 py-3 rounded-lg shadow-lg text-sm font-medium text-white transition-all ${
            toast.type === "success" ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Top Navigation & Actions */}
      <div className="mb-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <button
          onClick={handleBack}
          className="flex items-center text-slate-500 hover:text-slate-800 transition-colors font-medium"
        >
          <ArrowLeft size={20} className="mr-2" /> Back to files
        </button>

        <div className="flex gap-3">
          <button
            onClick={() => setShowEditDeal(true)}
            className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center gap-2"
          >
            <Pencil size={16} /> Edit Deal
          </button>
          {isCombinedDealType ? (
            // Purchase & Sale deal — offer a separate APS upload per side so
            // the Purchase APS and the Sale APS can each be uploaded/replaced
            // without affecting the other.
            <>
              <button
                onClick={() => { setApsFiles([]); setApsUploadSide("purchase"); setShowApsUpload(true); }}
                className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center gap-2"
              >
                <Upload size={16} /> Upload APS (Purchase)
              </button>
              <button
                onClick={() => { setApsFiles([]); setApsUploadSide("sale"); setShowApsUpload(true); }}
                className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center gap-2"
              >
                <Upload size={16} /> Upload APS (Sale)
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setApsFiles([]);
                const sole = (dealTypeParts[0] ?? "").toLowerCase();
                setApsUploadSide(sole === "purchase" ? "purchase" : sole === "sale" ? "sale" : null);
                setShowApsUpload(true);
              }}
              className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center gap-2"
            >
              <Upload size={16} /> Upload APS Document
            </button>
          )}
          <button
            onClick={() => { setShowDocuments(true); fetchDealDocuments(); }}
            className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center gap-2"
          >
            <FileText size={16} /> View Documents
          </button>
        </div>
      </div>

      {showEditDeal && (
        <EditDealModal
          dealId={deal.id}
          onClose={() => setShowEditDeal(false)}
          onSaved={() => {
            setShowEditDeal(false);
            refetchData();
            // The client name saves to `leads`, so refetchData() (tasks +
            // milestones only) can't surface it — pull the deal row too.
            void onDealChanged?.();
          }}
        />
      )}

      {showAddCoClient && (
        <AddCoClientModal
          dealId={deal.id}
          dealType={deal.type}
          propertyAddress={deal.propertyAddress || ""}
          sellingPropertyAddress={((deal as any).sellingPropertyAddress as string | undefined) || ""}
          onClose={() => setShowAddCoClient(false)}
          onAdded={() => {
            // Full reload so the new co-client appears in "People involved",
            // the Identification Documents card, and the family role numbering
            // — all of which are derived from the server's linked_deals.
            window.location.reload();
          }}
        />
      )}

      {/* Citizenship flag banner */}
      {isNonCitizenFlagged({ citizenship_status: rawDeal?.lead_citizenship_status }) && (
        <div
          className="flex items-start gap-3 px-5 py-4 rounded-xl border bg-red-50 border-red-200 text-red-800 mb-6"
          title={NON_CITIZEN_FLAG_TOOLTIP}
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="text-sm font-semibold leading-snug">
            This client selected &ldquo;Non-Citizen or Unsure&rdquo; as their citizenship status.
          </div>
        </div>
      )}

      {/* "Referred By" card removed — the partner is shown in the Partner
          Details section (under Milestones). */}

      {/* Property Details Card (Top - Full Width) */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <div className="flex flex-col md:flex-row justify-between items-start gap-6">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-flex items-center px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-[10px] font-bold text-slate-600 uppercase tracking-wide">
                Property
              </span>
              <span className="inline-flex items-center px-2 py-0.5 bg-brand-light border border-brand-primary/20 rounded text-[10px] font-bold text-brand-primary uppercase tracking-wide">
                {deal.type}
              </span>
              <span className="text-xs font-medium text-slate-400 ml-1">
                {deal.fileNumber}
              </span>
            </div>

            <h1 className="text-2xl font-bold text-slate-900 mb-2 leading-tight">
              {(() => {
                // Combined deals follow the active tab; single-side deals
                // (including co-seller / co-purchaser deals narrowed from a
                // combined parent) follow their only part. Sale side prefers
                // selling_address_* but falls back to property_address when
                // the selling-side address isn't set.
                const effectiveSide = isCombinedDealType
                  ? activeWorkflowTab.toLowerCase()
                  : (dealTypeParts[0] ?? "").toLowerCase();
                if (effectiveSide === "sale") {
                  const sale = (deal as any).sellingPropertyAddress as string | undefined;
                  return getDisplayAddress(sale || deal.propertyAddress || "");
                }
                return getDisplayAddress(deal.propertyAddress);
              })()}
            </h1>

            {(() => {
              // Address sub-parts (unit / city / province / postal code).
              //
              // Purchase side reads from lead.address_*. Sale side prefers
              // lead.selling_address_* (only populated when the lead also
              // has a separate purchase property — e.g. combined deals or
              // co-seller leads); when that block is empty we fall back to
              // lead.address_* because convertLead seeds the deal's
              // property_address from lead.address_street for pure-Sale
              // leads too.
              const effectiveSide = isCombinedDealType
                ? activeWorkflowTab.toLowerCase()
                : (dealTypeParts[0] ?? "").toLowerCase();
              const isSale = effectiveSide === "sale";
              const sellingStreet = rawDeal?.lead_selling_address_street as string | null | undefined;
              const sellingCity = rawDeal?.lead_selling_address_city as string | null | undefined;
              const sellingProvince = rawDeal?.lead_selling_address_province as string | null | undefined;
              const sellingPostal = rawDeal?.lead_selling_address_postal_code as string | null | undefined;
              const hasSellingAddress = Boolean(
                sellingStreet || sellingCity || sellingProvince || sellingPostal,
              );
              const useSelling = isSale && hasSellingAddress;
              const unit = useSelling ? null : (rawDeal?.lead_address_unit as string | null | undefined);
              const city = useSelling
                ? sellingCity
                : (rawDeal?.lead_address_city as string | null | undefined);
              const province = useSelling
                ? sellingProvince
                : (rawDeal?.lead_address_province as string | null | undefined);
              const postal = useSelling
                ? sellingPostal
                : (rawDeal?.lead_address_postal_code as string | null | undefined);
              const parts = [unit && `Unit ${unit}`, city, province, postal].filter(Boolean);
              if (parts.length === 0) return null;
              return (
                <p className="text-sm text-slate-500 mb-4 leading-snug">
                  {parts.join(" · ")}
                </p>
              );
            })()}

            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <Calendar size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Closing Date
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    {deal.closingDate ? formatLocalDate(deal.closingDate) : "TBD"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <Calendar size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Opening Date
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    {rawDeal?.opening_date ? formatLocalDate(rawDeal.opening_date as string) : "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <Calendar size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Requisition Date
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    {rawDeal?.requisition_date ? formatLocalDate(rawDeal.requisition_date as string) : "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <User size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Lawyer
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    {(rawDeal?.lawyer_name as string | null | undefined) || "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <User size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Clerk
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    {(rawDeal?.clerk_name as string | null | undefined) || "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <CheckCircle size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Deal Status
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    {deal.status === DealStatus.CLOSED
                      ? "Closed"
                      : rawDeal?.account_created_at
                      ? "Active"
                      : "Inactive"}
                  </p>
                </div>
              </div>
              {typeof rawDeal?.price === "number" && rawDeal.price > 0 && (
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                    <FileText size={14} />
                  </div>
                  <div>
                    <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                      Price
                    </p>
                    <p className="font-bold text-sm text-slate-900 leading-none">
                      ${Number(rawDeal.price).toLocaleString()}
                    </p>
                  </div>
                </div>
              )}
              {(rawDeal?.file_name as string | null | undefined) && (
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                    <FileText size={14} />
                  </div>
                  <div>
                    <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                      File Name
                    </p>
                    <p className="font-bold text-sm text-slate-900 leading-none">
                      {(rawDeal?.file_name as string | null | undefined) ?? ""}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Role indicator (top-right of property card). Tells the
              admin immediately which person in the family they're
              viewing — Primary Purchaser / Primary Seller, or
              Co-Purchaser 1 / Co-Seller 1, etc. The Building watermark
              sits behind it. */}
          <div className="hidden md:flex flex-col items-end gap-2 relative">
            {numberedRoles.current && (
              <span
                className={`text-base font-bold ${
                  numberedRoles.current.toLowerCase().startsWith("primary")
                    ? "text-green-700"
                    : numberedRoles.current.toLowerCase().includes("co-seller")
                    ? "text-orange-600"
                    : "text-blue-600"
                }`}
                title="Currently viewing this person's deal"
              >
                {numberedRoles.current}
              </span>
            )}
            <div className="opacity-5 text-slate-900">
              <Building2 size={80} />
            </div>
          </div>
        </div>
      </div>

      {/* People Involved Section — lists every person in the family
          (primary + co-purchasers + co-sellers) with a clear chip for
          each role. The currently-viewed deal is not clickable; clicking
          any other entry navigates to that deal so the admin can switch
          perspectives. */}
      {(
        <div className="bg-white rounded-xl shadow-sm border border-blue-200 p-5 mb-6">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 flex-shrink-0">
                <User size={14} />
              </div>
              <h3 className="text-sm font-bold text-slate-900">People involved</h3>
              <span className="text-[11px] text-slate-400 truncate">
                {includeFamilyTasks
                  ? "Everyone's tasks are listed together below"
                  : "Click any person to switch to their view"}
              </span>
            </div>
            {/* Add Co-Purchaser / Co-Seller — only on the primary's view, and
                only for deals that have a purchase or sale side. Co-clients on
                a refinance aren't a concept here. Clicking opens a modal that
                creates the child lead and runs the same conversion the customer
                portal does (invite + welcome email, shared-task sync, ID task).
                Identification upload itself lives in the dedicated card below. */}
            {/* Temporarily hidden — Add Co-Purchaser / Co-Seller button commented out for now.
            {(() => {
              const currentRole = ((rawDeal?.current_deal_role as string | undefined) ?? "").toLowerCase();
              const isCoLeadView = currentRole.startsWith("co-");
              const dt = (deal.type ?? "").toLowerCase();
              const dealSupportsCoClient = dt.includes("purchase") || dt.includes("sale");
              if (isCoLeadView || !dealSupportsCoClient) return null;
              return (
                <button
                  type="button"
                  onClick={() => setShowAddCoClient(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#C10007] text-white hover:bg-[#a30006] transition-colors shadow-sm flex-shrink-0"
                  title="Add a co-purchaser or co-seller to this file"
                >
                  <UserPlus size={13} />
                  Add Co-Purchaser / Co-Seller
                </button>
              );
            })()}
            */}
          </div>
          <div className="space-y-2">
            {(() => {
              return familyPeople.map((p) => (
                <div
                  key={p.id}
                  onClick={
                    includeFamilyTasks || p.isCurrent
                      ? undefined
                      : () => router.push(`/admin/deals/${p.id}`)
                  }
                  className={`flex items-center justify-between px-4 py-3 rounded-lg border transition-all group ${
                    includeFamilyTasks || p.isCurrent
                      ? "border-slate-100 cursor-default"
                      : "border-slate-100 hover:border-blue-200 hover:bg-blue-50/50 cursor-pointer"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${roleChipClass(p.role)}`}>
                      {p.role}
                    </span>
                    <div>
                      <p className={`text-sm font-bold transition-colors ${
                        includeFamilyTasks || p.isCurrent
                          ? "text-slate-800"
                          : "text-slate-800 group-hover:text-blue-700"
                      }`}>
                        {p.lead_name}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {p.file_number}
                        {(() => {
                          // Co-sellers should display their selling property,
                          // not the deal's stored purchase address.
                          const role = p.role.toLowerCase();
                          const isCoSeller = role.includes("co-seller");
                          const isPrimary = role.startsWith("primary");
                          const purchaseAddr = p.property_address;
                          const saleAddr = p.selling_property_address;
                          if (isCoSeller) {
                            const addr = saleAddr || purchaseAddr;
                            return addr ? ` · ${addr}` : "";
                          }
                          // The primary on a combined Purchase & Sale deal acts
                          // on both sides, so surface both the purchase and the
                          // selling address (not just the purchase one).
                          if (
                            isPrimary &&
                            isCombinedDealType &&
                            saleAddr &&
                            saleAddr !== purchaseAddr
                          ) {
                            const addrs = [purchaseAddr, saleAddr].filter(Boolean);
                            return addrs.length ? ` · ${addrs.join(" · ")}` : "";
                          }
                          // Primaries / Co-Purchasers otherwise show the
                          // purchase address (their primary side).
                          return purchaseAddr ? ` · ${purchaseAddr}` : "";
                        })()}
                      </p>
                      {p.lead_email && (
                        <p className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5">
                          <Mail size={11} className="text-slate-400" />
                          <a
                            href={`mailto:${p.lead_email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="hover:text-brand-primary hover:underline"
                          >
                            {p.lead_email}
                          </a>
                        </p>
                      )}
                      {/* Phone — displayed alongside email, editable inline.
                          Saves to the person's lead row via /api/admin/leads. */}
                      {editingPhoneLeadId && editingPhoneLeadId === p.lead_id ? (
                        <div
                          className="flex items-center gap-1 mt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Phone size={11} className="text-slate-400" />
                          <input
                            type="tel"
                            value={phoneDraft}
                            autoFocus
                            placeholder="(416) 555-1234"
                            onChange={(e) => setPhoneDraft(formatPhoneAsTyped(e.target.value))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSavePhone(p);
                              if (e.key === "Escape") cancelEditPhone();
                            }}
                            className="text-[11px] border border-slate-300 rounded px-1.5 py-0.5 w-36 focus:outline-none focus:ring-1 focus:ring-brand-primary"
                          />
                          <button
                            onClick={() => handleSavePhone(p)}
                            disabled={savingPhoneId === p.id}
                            title="Save phone number"
                            className="text-green-600 hover:text-green-700 disabled:opacity-40 p-0.5 cursor-pointer"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            onClick={cancelEditPhone}
                            title="Cancel"
                            className="text-slate-400 hover:text-red-500 p-0.5 cursor-pointer"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ) : (
                        <p className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5">
                          <Phone size={11} className="text-slate-400" />
                          {p.lead_phone ? (
                            <a
                              href={`tel:${p.lead_phone}`}
                              onClick={(e) => e.stopPropagation()}
                              className="hover:text-brand-primary hover:underline"
                            >
                              {p.lead_phone}
                            </a>
                          ) : (
                            <span className="text-slate-400 italic">No phone number</span>
                          )}
                          {p.lead_id && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                beginEditPhone(p);
                              }}
                              title="Edit phone number"
                              className="text-slate-300 hover:text-brand-primary transition-colors p-0.5 cursor-pointer"
                            >
                              <Pencil size={10} />
                            </button>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleImpersonate(p);
                      }}
                      disabled={!p.accountCreated || !p.lead_email || impersonatingId === p.id}
                      className="text-slate-400 hover:text-brand-primary transition-colors p-1 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      title={
                        p.accountCreated
                          ? `Login as this client (${p.role})`
                          : "Client has not signed in to the portal yet"
                      }
                    >
                      <LogIn size={14} />
                    </button>
                    {/* Document-uploader badge — three states resolved from the
                        primary's upload_mode. Only meaningful once there's more
                        than one person on the file:
                          • designated uploader          → "Can upload for all"
                          • someone else uploads for them → "Uploaded by {name}"
                          • everyone uploads their own    → "Uploads own" */}
                    {familyPeople.length > 1 && (
                      p.canUploadForAll ? (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-50 text-green-700 border border-green-300"
                          title="This person uploads documents for everyone on this file"
                        >
                          <Upload size={10} />
                          Can upload for all
                        </span>
                      ) : familyUploader ? (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-300"
                          title={`Documents uploaded by ${familyUploader.lead_name}`}
                        >
                          <Upload size={10} />
                          Uploaded by {familyUploader.lead_name}
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-300"
                          title="This person uploads their own documents"
                        >
                          <Upload size={10} />
                          Uploads own
                        </span>
                      )
                    )}
                    {/* Retainer badge — only once we know this person's status
                        (see retainerSigned above); an unresolved lead_id renders
                        nothing rather than a wrong "not signed". */}
                    {p.lead_id && p.lead_id in retainerSigned && (
                      retainerSigned[p.lead_id] ? (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-300"
                          title="This person has signed the retainer agreement"
                        >
                          <FileSignature size={10} />
                          Retainer signed
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-300"
                          title="This person has not signed the retainer agreement yet"
                        >
                          <FileText size={10} />
                          Retainer not signed
                        </span>
                      )
                    )}
                    {p.accountCreated ? (
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white text-green-600 border border-green-400"
                        title="Client has signed in to the portal"
                      >
                        Active
                      </span>
                    ) : (
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200"
                        title="Client has not signed in to the portal yet"
                      >
                        Inactive
                      </span>
                    )}
                    {!p.isCurrent && !includeFamilyTasks && (
                      <ExternalLink size={14} className="text-slate-300 group-hover:text-blue-500" />
                    )}
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* Submit-on-behalf section — only on the PRIMARY's view, and only when
          the primary is the family's designated uploader (upload_mode === 'me',
          surfaced as primary_submit_on_behalf by the deals API). When the
          primary is not the uploader, nothing renders here. */}
      {(() => {
        const isPrimaryView =
          ((rawDeal?.current_deal_role as string | undefined) ?? "")
            .toLowerCase()
            .startsWith("primary") || !rawDeal?.current_deal_role;
        const hasAccess = rawDeal?.primary_submit_on_behalf === true;
        if (!isPrimaryView || !hasAccess) return null;
        const coPersons: OnBehalfCoPerson[] = familyPeople
          .filter(
            (p) =>
              !p.isCurrent &&
              p.lead_id &&
              p.role.toLowerCase().includes("co-"),
          )
          .map((p) => ({
            leadId: p.lead_id as string,
            dealId: p.id,
            name: p.lead_name,
            role: p.role,
            email: p.lead_email,
            phone: p.lead_phone,
            identificationTaskId: p.identificationTaskId,
            identificationStatus: p.identificationStatus,
          }));
        if (coPersons.length === 0) return null;
        // Section hidden per request — set showSection to true to restore it.
        const showSection = false;
        return showSection ? (
          <SubmitOnBehalfSection
            coPersons={coPersons}
            onOpen={(kind, person) => {
              if (kind === "upload-id") {
                if (person.identificationTaskId) {
                  openIdDrawerFor(person.leadId, person.identificationTaskId);
                }
              } else {
                const fp = familyPeople.find((p) => p.lead_id === person.leadId);
                setPersonalInfoChanged(false);
                setPersonalInfoModal({
                  leadId: person.leadId,
                  dealId: person.dealId ?? fp?.id ?? deal.id,
                  name: person.name ?? fp?.lead_name ?? "",
                  role: person.role ?? fp?.role ?? "",
                });
              }
            }}
          />
        ) : null;
      })()}

      <div className="space-y-8">
        {/* Tasks Section */}
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-bold text-slate-900">Tasks</h2>
            <div className="flex items-center gap-2">
              {/* "Download All" only makes sense once there's finished work to
                  export — show it only when at least one task is completed. */}
              {tasks.some((t) => t.status === "Completed") && (
              <button
                onClick={handleDownloadDealPdf}
                disabled={downloadingDealPdf}
                className="bg-brand-primary text-white hover:bg-brand-primaryHover px-3 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-sm disabled:opacity-60"
                title="Download all tasks and documents as a single PDF"
              >
                {downloadingDealPdf ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Preparing PDF…
                  </>
                ) : (
                  <>
                    <FileDown size={16} /> Download All
                  </>
                )}
              </button>
              )}
              {/* Add Task hidden per request.
              <button
                onClick={() => setShowTaskForm(true)}
                className="text-brand-primary text-xs font-bold flex items-center hover:bg-brand-light px-2 py-1 rounded transition-colors"
              >
                <Plus size={14} className="mr-1" />
                Add Task
              </button>
              */}
            </div>
          </div>

          {isCombinedDealType && (
            <div className="flex gap-1 border-b border-slate-200">
              {dealTypeParts.map((part) => {
                const isActive = part.toLowerCase() === activeTaskTab.toLowerCase();
                return (
                  <button
                    key={part}
                    onClick={() => setActiveTaskTab(part)}
                    className={`px-4 py-2 text-xs font-bold uppercase tracking-wide border-b-2 -mb-px transition-colors ${
                      isActive
                        ? "border-brand-primary text-brand-primary"
                        : "border-transparent text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {part}
                  </button>
                );
              })}
            </div>
          )}

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-2 sm:px-3 py-3 w-8 hidden sm:table-cell"></th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-8 text-center">
                      #
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-24 sm:w-32">
                      Status
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider">
                      Task Name
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-12 sm:w-16">
                      Doc
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-20 hidden md:table-cell">
                      Deadline
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-28 hidden lg:table-cell">
                      Completed
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-16 text-center">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {displayTasks.map((task, index) => (
                    <tr
                      key={task.id}
                      draggable={!task.isTemplate}
                      onDragStart={() => !task.isTemplate && (dragTaskItem.current = index)}
                      onDragEnter={() => !task.isTemplate && (dragTaskOverItem.current = index)}
                      onDragEnd={!task.isTemplate ? handleSortTasks : undefined}
                      onDragOver={(e) => e.preventDefault()}
                      onMouseDown={(e) => { if (!task.isTemplate) (e.currentTarget as HTMLTableRowElement).style.cursor = 'grabbing'; }}
                      onMouseUp={(e) => { if (!task.isTemplate) (e.currentTarget as HTMLTableRowElement).style.cursor = 'grab'; }}
                      className={`hover:bg-slate-50 transition-colors group ${task.isTemplate ? "opacity-60" : "cursor-grab"}`}
                    >
                      <td className="px-2 sm:px-3 py-3 text-slate-300 hidden sm:table-cell">
                        {!task.isTemplate && <GripVertical size={16} />}
                      </td>
                      <td className="px-2 py-3 text-center text-xs text-slate-600 font-medium">
                        {index + 1}
                      </td>
                      <td className="px-2 py-3">
                        {task.isTemplate ? (
                          <span className={`text-xs font-semibold border rounded px-2 py-1 inline-block ${getStatusColor("Pending")}`}>
                            Pending
                          </span>
                        ) : (
                          // Click-to-toggle status: one tap flips between
                          // Pending and Completed. Tasks are only ever Pending
                          // or Completed — there is no partial state.
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const next: Task["status"] =
                                task.status === "Completed" ? "Pending" : "Completed";
                              handleTaskStatusChange(task.id, next);
                            }}
                            className={`text-xs font-semibold border rounded px-2 py-1 cursor-pointer transition-colors ${getStatusColor(task.status || "Pending")}`}
                            title={
                              task.status === "Completed"
                                ? "Click to mark Pending"
                                : "Click to mark Completed"
                            }
                          >
                            {task.status || "Pending"}
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (task.isTemplate) {
                              openTaskView(task);
                            } else {
                              openEditTask(task);
                            }
                          }}
                          className="text-sm font-semibold text-slate-800 block leading-tight text-left hover:text-brand-primary transition-colors cursor-pointer bg-transparent border-none p-0"
                          title={task.isTemplate ? "View details" : "View / edit task"}
                        >
                          {/* In the unified family view, per-person personal
                              tasks carry an owner name so the same template
                              (ID / Personal Information) is distinguishable per
                              person. Rendered, not stored on task.title. */}
                          {task.ownerName ? `${task.title} - ${task.ownerName}` : task.title}
                        </button>
                      </td>
                      <td className="px-2 py-3">
                        {task.isTemplate ? (
                          <span className="text-slate-300 text-xs">-</span>
                        ) : (() => {
                          const matched = getTaskFileDocs(task);
                          // Diagnostic: print one-time per render if a task
                          // has a template_id but found zero matches even
                          // though docs exist with shared_task_key set.
                          if (process.env.NODE_ENV !== "production" && matched.length === 0 && task.taskTemplateId) {
                            const candidates = taskFileDocs.filter((d: any) => d.field_type === "file");
                            if (candidates.length > 0) {
                              console.log("[Doc column miss]", {
                                task_id: task.id,
                                task_template_id: task.taskTemplateId,
                                task_title: task.title,
                                candidate_docs: candidates.map((d: any) => ({
                                  task_id: d.task_id,
                                  shared_task_key: d.shared_task_key,
                                  task_title: d.task_title,
                                  file_name: d.file_name,
                                  is_shared: d.is_shared,
                                })),
                              });
                            }
                          }
                          return matched.length > 0 ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setTaskDocsPopup({
                                  taskTitle: task.title,
                                  docs: matched,
                                  isAps: !!(
                                    task.taskTemplateId &&
                                    (taskTemplates as any[]).find((t) => t.id === task.taskTemplateId)?.is_aps_task
                                  ),
                                });
                              }}
                              className="flex items-center gap-1.5 text-xs text-brand-primary hover:text-brand-primaryHover cursor-pointer relative z-10 bg-transparent border-none p-0 transition-colors"
                              title={`${matched.length} document${matched.length !== 1 ? "s" : ""}`}
                            >
                              <FileText size={14} className="shrink-0" />
                              <span className="font-medium">{matched.length}</span>
                            </button>
                          ) : (
                            <span className="text-slate-300 text-xs">-</span>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 hidden md:table-cell">
                        {task.isTemplate ? (
                          <span className="text-slate-300 text-xs">-</span>
                        ) : (
                          <div className="relative">
                            <input
                              type="date"
                              value={task.dueDate ?? ""}
                              min="1900-01-01"
                              max="2100-12-31"
                              onChange={async (e) => {
                                const newDate = e.target.value || null;
                                setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, dueDate: newDate ?? undefined } : t));
                                await fetch("/api/admin/tasks", {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ id: task.id, due_date: newDate }),
                                });
                              }}
                              className="absolute inset-0 opacity-0 cursor-pointer w-full"
                            />
                            {task.dueDate ? (
                              <span className="text-xs font-medium text-slate-700">
                                {formatLocalDate(task.dueDate)}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-300">—</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-3 hidden lg:table-cell">
                        <span className="text-xs text-slate-500">
                          {task.isTemplate
                            ? "-"
                            : task.completedAt
                              ? formatLocalDate(task.completedAt)
                              : "-"}
                        </span>
                      </td>
                      <td className="px-2 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {/* Download this task as a PDF — task info + personal
                              info responses + any uploaded files embedded. Shown
                              once a task is completed, or whenever it already has
                              data to download. */}
                          {!task.isTemplate && (task.status === "Completed" || taskHasData(task)) && (
                            <button
                              onClick={() => handleDownloadTaskPdf(task)}
                              disabled={downloadingTaskId === task.id}
                              className="text-slate-400 hover:text-brand-primary p-1 transition-colors disabled:opacity-50"
                              title="Download task as PDF"
                            >
                              {downloadingTaskId === task.id ? (
                                <Loader2 size={16} className="animate-spin" />
                              ) : (
                                <Download size={16} />
                              )}
                            </button>
                          )}
                          {!task.isTemplate && (
                            <button onClick={() => handleDeleteTask(task.id)} className="text-slate-300 hover:text-red-600 p-1 transition-colors">
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {displayTasks.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-6 py-8 text-center text-slate-400 text-sm"
                      >
                        No tasks assigned.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Milestones & Partner Section */}
        <div className="space-y-6">
          {/* Milestones */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-slate-900">Milestones</h2>
              {/* Add Stage hidden per request.
              <button
                onClick={() => setShowStageForm(true)}
                className="text-brand-primary text-xs font-bold flex items-center hover:bg-brand-light px-2 py-1 rounded transition-colors"
              >
                <Plus size={14} className="mr-1" /> Add Stage
              </button>
              */}
            </div>

            {isCombinedDealType && (
              <div className="flex gap-1 border-b border-slate-200 mb-4">
                {dealTypeParts.map((part) => {
                  const isActive = part.toLowerCase() === activeMilestoneTab.toLowerCase();
                  return (
                    <button
                      key={part}
                      onClick={() => setActiveMilestoneTab(part)}
                      className={`px-4 py-2 text-xs font-bold uppercase tracking-wide border-b-2 -mb-px transition-colors ${
                        isActive
                          ? "border-brand-primary text-brand-primary"
                          : "border-transparent text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      {part}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-2 sm:px-3 py-3 w-8 hidden sm:table-cell"></th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-8 text-center">
                        #
                      </th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-24 sm:w-32">
                        Status
                      </th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider">
                        Milestone Name
                      </th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-20 hidden md:table-cell">
                        Deadline
                      </th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-16 text-center">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {displayMilestones.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8 text-sm text-slate-400">
                          No milestones added
                        </td>
                      </tr>
                    ) : (
                      displayMilestones.map((milestone, index) => {
                        return (
                          <React.Fragment key={milestone.id}>
                            <tr
                              draggable={!milestone.isTemplate && !milestone.isPersonalSplit}
                              onDragStart={() => !milestone.isTemplate && !milestone.isPersonalSplit && (dragMilestoneItem.current = index)}
                              onDragEnter={() => !milestone.isTemplate && !milestone.isPersonalSplit && (dragMilestoneOverItem.current = index)}
                              onDragEnd={!milestone.isTemplate && !milestone.isPersonalSplit ? handleSortMilestones : undefined}
                              onDragOver={(e) => e.preventDefault()}
                              onMouseDown={(e) => { if (!milestone.isTemplate && !milestone.isPersonalSplit) (e.currentTarget as HTMLTableRowElement).style.cursor = 'grabbing'; }}
                              onMouseUp={(e) => { if (!milestone.isTemplate && !milestone.isPersonalSplit) (e.currentTarget as HTMLTableRowElement).style.cursor = 'grab'; }}
                              className={`hover:bg-slate-50 transition-colors group bg-white ${milestone.isTemplate ? "opacity-60" : milestone.isPersonalSplit ? "" : "cursor-grab"}`}
                            >
                              <td className="px-2 sm:px-3 py-3 text-slate-300 hidden sm:table-cell">
                                {!milestone.isTemplate && !milestone.isPersonalSplit && <GripVertical size={16} />}
                              </td>

                              <td className="px-2 py-3 text-center text-xs text-slate-600 font-medium">
                                {index + 1}
                              </td>

                              <td className="px-2 py-3">
                                {milestone.isTemplate ? (
                                  <span className={`text-xs font-semibold border rounded px-2 py-1 inline-block ${getStatusColor("Pending")}`}>
                                    Pending
                                  </span>
                                ) : milestone.isPersonalSplit || milestone.personalProgress ? (
                                  // Personal-task stage — status is the aggregate
                                  // task-derived progress across the family, shown
                                  // read-only (see the "X/N completed" badge on the title).
                                  <span className={`text-xs font-semibold border rounded px-2 py-1 inline-block ${getStatusColor(milestone.status || "Pending")}`}>
                                    {milestone.status || "Pending"}
                                  </span>
                                ) : (
                                  // Click-to-toggle status (matches the task
                                  // table): one tap flips Pending ⇄ Completed —
                                  // completing the milestone cascades to its
                                  // tasks and fires the milestone email as before.
                                  // Milestones are only ever Pending or Completed.
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const next: Milestone["status"] =
                                        milestone.status === "Completed" ? "Pending" : "Completed";
                                      handleMilestoneStatusChange(milestone.id, next);
                                    }}
                                    className={`text-xs font-semibold border rounded px-2 py-1 cursor-pointer transition-colors ${getStatusColor(milestone.status || "Pending")}`}
                                    title={
                                      milestone.status === "Completed"
                                        ? "Click to mark Pending"
                                        : "Click to mark Completed"
                                    }
                                  >
                                    {milestone.status || "Pending"}
                                  </button>
                                )}
                              </td>

                              <td className="px-2 py-3">
                                {milestone.isTemplate || milestone.isPersonalSplit ? (
                                  <span className="text-sm text-slate-800 font-semibold">
                                    {milestone.title}
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openEditMilestone(milestone);
                                    }}
                                    className="text-sm text-slate-800 font-semibold text-left hover:text-brand-primary transition-colors cursor-pointer bg-transparent border-none p-0"
                                    title="View / edit milestone"
                                  >
                                    {milestone.title}
                                  </button>
                                )}
                                {milestone.personalProgress && (
                                  <span
                                    className={`ml-2 text-[11px] font-semibold ${
                                      milestone.personalProgress.completed === milestone.personalProgress.total
                                        ? "text-green-600"
                                        : "text-[#C10007]"
                                    }`}
                                  >
                                    {milestone.personalProgress.completed}/{milestone.personalProgress.total} completed
                                  </span>
                                )}
                              </td>

                              <td className="px-2 py-3 hidden md:table-cell">
                                {milestone.isTemplate || milestone.isPersonalSplit || milestone.personalProgress ? (
                                  <span className="text-slate-300 text-xs">—</span>
                                ) : (
                                  <div className="relative">
                                    <input
                                      type="date"
                                      value={milestone.milestoneDate ?? ""}
                                      min="1900-01-01"
                                      max="2100-12-31"
                                      onChange={async (e) => {
                                        const newDate = e.target.value || null;
                                        setMilestones((prev) => prev.map((m) => m.id === milestone.id ? { ...m, milestoneDate: newDate ?? undefined } : m));
                                        await fetch("/api/admin/milestones", {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ id: milestone.id, milestone_date: newDate }),
                                        });
                                      }}
                                      className="absolute inset-0 opacity-0 cursor-pointer w-full"
                                    />
                                    {milestone.milestoneDate ? (
                                      <span className="text-xs font-medium text-slate-700">
                                        {formatLocalDate(milestone.milestoneDate)}
                                      </span>
                                    ) : (
                                      <span className="text-xs text-slate-300">—</span>
                                    )}
                                  </div>
                                )}
                              </td>

                              <td className="px-2 py-3 text-right">
                                {/* Per-person split rows have no DB milestone of
                                    their own, so no email / delete actions. */}
                                {!milestone.isPersonalSplit && (
                                  <div className="flex items-center justify-end gap-1">
                                    {milestone.emailTemplateId && (
                                      <button
                                        title={milestone.emailSent ? "Email already sent" : "Send Email"}
                                        onClick={() => handleSendMilestoneEmail(milestone.id)}
                                        className={`p-1 rounded transition-colors ${milestone.emailSent ? "text-green-600 hover:bg-green-50" : "text-brand-primary hover:bg-brand-light"}`}
                                      >
                                        <Mail size={14} />
                                      </button>
                                    )}
                                    <button onClick={() => handleDeleteMilestone(milestone.id)} className="text-slate-300 hover:text-red-600 p-1 rounded transition-colors">
                                      <Trash2 size={16} />
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>

                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Lock Box Code — Purchase files only. Sits under Milestones and
              above Partner Details. Editable inline; saves to the deal via PATCH
              and feeds the {{ lockbox_code }} email variable. */}
          {(deal.type ?? "").toLowerCase().includes("purchase") && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-bold text-slate-800 text-sm">Lock Box Code</h3>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={lockboxDraft}
                    onChange={(e) => setLockboxDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveLockboxCode();
                    }}
                    placeholder="e.g. 1234#"
                    className="w-32 px-2 py-1.5 text-sm text-right border border-slate-200 rounded-md focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  />
                  {lockboxDraft.trim() !== (lockboxValue ?? "").trim() && (
                    <button
                      onClick={saveLockboxCode}
                      disabled={savingLockbox}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-[#C10007] rounded-md hover:bg-[#a30006] disabled:opacity-60 whitespace-nowrap"
                    >
                      {savingLockbox ? "Saving…" : "Save"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Partner Details — the deal's referral partner (from
              deals.partner_id, or a free-text referral agent). Hidden when
              there's no partner in the DB. */}
          {(() => {
            const rp = rawDeal?.referral_partner as
              | {
                  agent_name: string | null;
                  agent_email: string | null;
                  agent_phone: string | null;
                  brokerage_type: string | null;
                  brokerage_name: string | null;
                  referral_code: string | null;
                }
              | null
              | undefined;
            const partnerCompany =
              rp?.brokerage_name || ((rawDeal?.referral_agent_company as string | null | undefined) ?? null);
            const partnerPerson =
              rp?.agent_name || ((rawDeal?.referral_agent_name as string | null | undefined) ?? null);
            const partnerEmail =
              rp?.agent_email || ((rawDeal?.referral_agent_email as string | null | undefined) ?? null);
            const partnerPhone = rp?.agent_phone ?? null;
            const partnerType = rp?.brokerage_type ?? null;
            const hasPartner = !!(partnerPerson || partnerCompany || partnerEmail);

            if (!hasPartner) return null;

            const logoSource = partnerCompany || partnerPerson || "";
            const initials =
              logoSource
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((w) => w[0]?.toUpperCase() ?? "")
                .join("") || "—";

            return (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <h3 className="font-bold text-slate-800 text-sm mb-4">Partner Details</h3>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-slate-900 text-white rounded-lg flex items-center justify-center font-black text-xs shadow-md shrink-0">
                    {initials}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 truncate">
                      {partnerCompany || partnerPerson}
                    </p>
                    {partnerType && <p className="text-xs text-slate-500">{partnerType}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <p className="text-[10px] text-slate-500 font-medium mb-0.5 uppercase tracking-wide">
                      Agent
                    </p>
                    <p className="font-bold text-slate-800 text-xs">{partnerPerson || "—"}</p>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <p className="text-[10px] text-slate-500 font-medium mb-0.5 uppercase tracking-wide">
                      Phone
                    </p>
                    {partnerPhone ? (
                      <a
                        href={`tel:${partnerPhone}`}
                        className="font-bold text-slate-800 hover:text-brand-primary truncate block text-xs"
                      >
                        {partnerPhone}
                      </a>
                    ) : (
                      <p className="font-bold text-slate-400 text-xs">—</p>
                    )}
                  </div>
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 sm:col-span-2">
                    <p className="text-[10px] text-slate-500 font-medium mb-0.5 uppercase tracking-wide">
                      Email
                    </p>
                    {partnerEmail ? (
                      <a
                        href={`mailto:${partnerEmail}`}
                        className="font-bold text-brand-primary hover:underline truncate block text-xs"
                      >
                        {partnerEmail}
                      </a>
                    ) : (
                      <p className="font-bold text-slate-400 text-xs">—</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
      {showStageForm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add Stage"
          className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20 transition-[left] duration-300"
          onClick={() => setShowStageForm(false)}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Add Stage</h3>
                <p className="text-xs text-gray-400 mt-1">Add a new milestone stage to this deal.</p>
              </div>
              <button
                onClick={() => setShowStageForm(false)}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
              {/* Stage Template */}
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Stage Template
                </label>
                <select
                  name="stageTemplate"
                  value={stageForm.stageTemplate}
                  onChange={handleStageFormChange}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                >
                  <option value="">Select Stage Template</option>
                  {stageTemplates
                    .filter((t) => matchesDealType(t.lead_type))
                    // Milestones are per-side deal stages, not personal items —
                    // scope to the active Purchase/Sale tab so the stage lands
                    // on the correct side (matching how milestones are seeded).
                    .filter((t) => matchesActiveTab(t.lead_type, activeMilestoneTab))
                    .map((t) => {
                    const label = `${t.lead_type}-${t.role}-${t.name}`;
                    return (
                      <option key={t.id} value={t.name} title={label}>
                        {label.length > 55 ? label.slice(0, 55) + "…" : label}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* No person picker: a milestone is a per-side deal stage that
                  fans out to linked deals, not a per-person item. */}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Status */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Status
                  </label>
                  <select
                    name="status"
                    value={stageForm.status}
                    onChange={handleStageFormChange}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  >
                    <option value="Pending">Pending</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>

                {/* Closing Date */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Closing Date
                  </label>
                  <input
                    type="date"
                    name="milestoneDate"
                    value={stageForm.milestoneDate}
                    onChange={handleStageFormChange}
                    min="1900-01-01"
                    max="2100-12-31"
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  />
                </div>
              </div>

              {/* Partner */}
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Partner
                </label>
                <select
                  name="partner"
                  value={stageForm.partner}
                  onChange={handleStageFormChange}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                >
                  <option value="">Select Partner</option>
                </select>
              </div>

              {/* Email Template */}
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Email Template
                </label>
                <select
                  name="emailTemplateId"
                  value={stageForm.emailTemplateId}
                  onChange={handleStageFormChange}
                  disabled={!stageForm.emailTemplateId}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white disabled:bg-gray-100 disabled:text-gray-400"
                >
                  {stageForm.emailTemplateId ? (
                    emailTemplates
                      .filter(t => t.id === stageForm.emailTemplateId)
                      .map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))
                  ) : (
                    <option value="">No email template</option>
                  )}
                </select>
              </div>
            </div>

            {/* Buttons */}
            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setShowStageForm(false)}
                className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveStage}
                className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006]"
              >
                Save Stage
              </button>
            </div>
          </div>
        </div>
      )}

      {showTaskForm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add Task"
          className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20 transition-[left] duration-300"
          onClick={() => setShowTaskForm(false)}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Add Task</h3>
                <p className="text-xs text-gray-400 mt-1">Create a new task for this deal.</p>
              </div>
              <button
                onClick={() => setShowTaskForm(false)}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
              {/* Person — value is the person's DEAL id, so the task is created
                  on their own deal and shows under them in the family view. */}
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Assign to
                </label>
                <select
                  name="client"
                  value={taskForm.client}
                  onChange={handleTaskFormChange}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                >
                  <option value="">Select Person</option>
                  {familyPeople.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.role} — {person.lead_name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Task Template */}
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Task Template
                </label>
                <select
                  name="title"
                  value={taskForm.title}
                  onChange={handleTaskFormChange}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                >
                  <option value="">Select Task Template</option>
                  {taskTemplates
                    .filter((template) => matchesDealType(template.lead_type))
                    // A co-purchaser only acts on Purchase, a co-seller only on
                    // Sale — narrow to the selected person's side so you can't
                    // add a Sale task to a purchaser. Primary is unscoped.
                    .filter((template) => {
                      const side = ownerDealSide.get(taskForm.client);
                      return !side || (template.lead_type ?? "").toLowerCase() === side.toLowerCase();
                    })
                    .map((template) => {
                    const label = `${template.lead_type} - ${template.role_type} - ${template.name}`;
                    return (
                      <option key={template.id} value={template.id} title={label}>
                        {label.length > 55 ? label.slice(0, 55) + '…' : label}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Status */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Status
                  </label>
                  <select
                    name="status"
                    value={taskForm.status}
                    onChange={handleTaskFormChange}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  >
                    <option value="Pending">Pending</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>

                {/* Deadline */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Deadline Date
                  </label>
                  <div className="relative">
                    <Calendar
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                    />
                    <input
                      type="date"
                      name="deadlineDate"
                      value={taskForm.deadlineDate}
                      onChange={handleTaskFormChange}
                      min="1900-01-01"
                      max="2100-12-31"
                      className="w-full pl-9 pr-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                    />
                  </div>
                </div>
              </div>

              {/* Milestone */}
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Milestone
                </label>
                <select
                  name="milestoneId"
                  value={taskForm.milestoneId}
                  onChange={handleTaskFormChange}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                >
                  <option value="">No Milestone</option>
                  {milestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Buttons */}
            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setShowTaskForm(false)}
                className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTask}
                className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006]"
              >
                Save Task
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Edit Milestone Modal */}
      {editingMilestone && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit Milestone"
          className="fixed inset-0 z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
          onClick={() => { if (!editMilestoneSaving) closeEditMilestone(); }}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Edit Milestone</h3>
                <p className="text-xs text-gray-400 mt-1">Update milestone details such as title, status and deadline.</p>
              </div>
              <button
                onClick={closeEditMilestone}
                disabled={editMilestoneSaving}
                className="text-gray-400 hover:text-gray-700 disabled:opacity-50 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Milestone Name <span className="text-[#C10007]">*</span>
                </label>
                <input
                  type="text"
                  value={editMilestoneTitle}
                  onChange={(e) => setEditMilestoneTitle(e.target.value)}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Status
                  </label>
                  <select
                    value={editMilestoneStatus || "Pending"}
                    onChange={(e) => setEditMilestoneStatus(e.target.value as Milestone["status"])}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  >
                    <option value="Pending">Pending</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Deadline
                  </label>
                  <input
                    type="date"
                    min="1900-01-01"
                    max="2100-12-31"
                    value={editMilestoneDate}
                    onChange={(e) => setEditMilestoneDate(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Email Template
                </label>
                <select
                  value={editMilestoneEmailTemplateId}
                  onChange={(e) => setEditMilestoneEmailTemplateId(e.target.value)}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                >
                  <option value="">No email template</option>
                  {emailTemplates.map((et: any) => (
                    <option key={et.id} value={et.id}>{et.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1.5">
                  Sent to the client when this milestone is marked Completed.
                </p>
              </div>

              {editingMilestone.completedAt && (
                <div>
                  <p className="text-sm font-semibold text-gray-800">Completed At</p>
                  <p className="text-sm text-gray-700 mt-1">{editingMilestone.completedAt}</p>
                </div>
              )}
            </div>
            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={closeEditMilestone}
                disabled={editMilestoneSaving}
                className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveEditMilestone}
                disabled={editMilestoneSaving}
                className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-50"
              >
                {editMilestoneSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* APS Upload Modal */}
      {showApsUpload && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Upload Complete Agreement of Purchase and Sale and Amendments"
          className="fixed inset-0 z-[60] flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
          onClick={() => { if (!uploadingAps) { setShowApsUpload(false); setApsFiles([]); } }}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-bold text-gray-900 leading-tight">
                    Upload Complete Agreement of Purchase and Sale and Amendments
                  </h3>
                  {apsUploadSide && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                        apsUploadSide === "sale"
                          ? "bg-orange-100 text-orange-700 border-orange-200"
                          : "bg-blue-100 text-blue-700 border-blue-200"
                      }`}
                    >
                      {apsUploadSide === "sale" ? "Sale" : "Purchase"}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {apsUploadSide
                    ? `Upload the ${apsUploadSide === "sale" ? "Sale" : "Purchase"}-side APS document to complete this task.`
                    : "Upload the required documents to complete this task."}
                </p>
              </div>
              <button
                onClick={() => { if (!uploadingAps) { setShowApsUpload(false); setApsFiles([]); } }}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                disabled={uploadingAps}
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <div className="px-6 py-6 space-y-5 overflow-y-auto">
              {existingApsCount > 0 && (
                <div className="flex items-start gap-3 px-4 py-3 rounded-lg border bg-blue-50 border-blue-200 text-blue-800">
                  <Info size={18} className="mt-0.5 shrink-0" />
                  <div className="text-sm leading-snug">
                    <p className="font-semibold">
                      {existingApsCount} APS document{existingApsCount === 1 ? "" : "s"} already uploaded for this deal.
                    </p>
                    <p className="mt-1 text-xs">
                      New files will be <span className="font-semibold">added</span>, not replaced.
                    </p>
                  </div>
                </div>
              )}
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-3">
                  Upload Agreement of Purchase and Sale <span className="text-[#C10007]">*</span>
                </label>

                {/* Selected files list — each removable before upload */}
                {apsFiles.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {apsFiles.map((f, idx) => (
                      <div
                        key={`${f.name}-${idx}`}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-green-50 border-green-200"
                      >
                        <CheckCircle size={18} className="text-green-600 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-slate-900 truncate">{f.name}</p>
                          <p className="text-xs text-slate-500">
                            {(f.size / (1024 * 1024)).toFixed(2)} MB · Ready to upload
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setApsFiles((prev) => prev.filter((_, i) => i !== idx))}
                          disabled={uploadingAps}
                          className="text-gray-400 hover:text-[#C10007] shrink-0 disabled:opacity-50"
                          aria-label={`Remove ${f.name}`}
                        >
                          <X size={18} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="relative group">
                <input
                  type="file"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png"
                  className="absolute inset-0 opacity-0 cursor-pointer z-10"
                  disabled={uploadingAps}
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    if (picked.length === 0) return;
                    const valid: File[] = [];
                    for (const f of picked) {
                      const ok =
                        f.type === "application/pdf" ||
                        f.type === "image/jpeg" ||
                        f.type === "image/jpg" ||
                        f.type === "image/png";
                      if (!ok) {
                        showToast(`"${f.name}" skipped — only PDF, JPG, JPEG or PNG files are accepted.`, "error");
                        continue;
                      }
                      if (f.size > 10 * 1024 * 1024) {
                        showToast(`"${f.name}" skipped — exceeds the 10MB maximum size.`, "error");
                        continue;
                      }
                      valid.push(f);
                    }
                    // Append, so picking files in multiple passes accumulates.
                    if (valid.length > 0) setApsFiles((prev) => [...prev, ...valid]);
                    e.target.value = "";
                  }}
                />
                <div
                  className="px-6 py-10 border-2 border-dashed rounded-xl flex flex-col items-center justify-center transition-all bg-gray-50 border-gray-200 group-hover:border-[#C10007] group-hover:bg-[#FEF2F2]"
                >
                  <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 mb-3">
                    <Upload size={22} />
                  </div>
                  <p className="text-sm font-bold text-slate-900">
                    {apsFiles.length > 0 ? "Add more files" : "Upload Agreement of Purchase and Sale"}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Click or drag &middot; multiple files &middot; .pdf,.jpg,.jpeg,.png &middot; Max 10MB each
                  </p>
                </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => { setShowApsUpload(false); setApsFiles([]); }}
                className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2] disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={uploadingAps}
              >
                Cancel
              </button>
              <button
                onClick={handleApsUploadSubmit}
                disabled={apsFiles.length === 0 || uploadingAps || apsStatusLoading}
                className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploadingAps
                  ? "Uploading..."
                  : apsFiles.length > 1
                    ? `Upload ${apsFiles.length} & Submit`
                    : "Upload & Submit"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Documents Modal */}
      {showDocuments && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Documents"
          className="fixed inset-0 z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
          onClick={() => setShowDocuments(false)}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Documents</h3>
                <p className="text-xs text-gray-400 mt-1">Review all documents uploaded for this deal.</p>
              </div>
              <button
                onClick={() => setShowDocuments(false)}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
              {loadingDocs ? (
                <p className="text-sm text-gray-400 text-center py-8">Loading documents...</p>
              ) : dealDocuments.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No documents uploaded yet.</p>
              ) : (
                <div className="space-y-5">
                  {Object.entries(
                    dealDocuments
                      // Only show documents for the side(s) this deal actually
                      // covers: a co-seller sees the Sale APS, a co-purchaser
                      // the Purchase APS, and a combined primary sees both.
                      // Side-agnostic docs (no resolvable lead type) always show.
                      .filter((doc) => {
                        const s = docSide(doc);
                        return !s || matchesDealType(s);
                      })
                      .reduce((acc: Record<string, any[]>, doc) => {
                        const key = doc.task_title || "Other";
                        if (!acc[key]) acc[key] = [];
                        acc[key].push(doc);
                        return acc;
                      }, {})
                  ).map(([taskTitle, docs]) => (
                    <div key={taskTitle}>
                      <h4 className="text-sm font-semibold text-gray-800 mb-2">{taskTitle}</h4>
                      <ul className="space-y-2">
                        {docs.map((doc: any, idx: number) => (
                          <li key={`${doc.id}-${idx}`} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                            <div className="flex items-start gap-3 min-w-0">
                              <FileText size={16} className="text-gray-400 shrink-0 mt-0.5" />
                              <div className="min-w-0 flex flex-col">
                                <div className="flex items-center gap-2 min-w-0">
                                  <p className="text-sm font-medium text-gray-800 truncate">{doc.file_name}</p>
                                  {(() => {
                                    const side = docSide(doc);
                                    if (!side) return null;
                                    return (
                                      <span
                                        className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                          side === "Sale"
                                            ? "bg-orange-100 text-orange-700 border-orange-200"
                                            : "bg-blue-100 text-blue-700 border-blue-200"
                                        }`}
                                      >
                                        {side}
                                      </span>
                                    );
                                  })()}
                                </div>
                                <IdentificationChip meta={findIdMeta(doc)} />
                              </div>
                            </div>
                            {doc.file_url ? (
                              <a
                                href={docDownloadHref(doc.file_url)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-semibold text-[#C10007] hover:underline shrink-0 ml-3"
                              >
                                View
                              </a>
                            ) : (
                              <span className="text-xs text-gray-400 shrink-0 ml-3">No file</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setShowDocuments(false)}
                className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Task Documents Popup */}
      {taskDocsPopup && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Documents"
          className="fixed inset-0 z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
          onClick={() => setTaskDocsPopup(null)}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Documents</h3>
                <p className="text-xs text-gray-400 truncate mt-1">{taskDocsPopup.taskTitle}</p>
              </div>
              <button
                onClick={() => setTaskDocsPopup(null)}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
              <ul className="space-y-2">
                {taskDocsPopup.docs.map((doc: any, i: number) => (
                  <li key={i} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                    <div className="flex items-start gap-3 min-w-0">
                      <FileText size={16} className="text-gray-400 shrink-0 mt-0.5" />
                      <div className="min-w-0 flex flex-col">
                        <p className="text-sm font-medium text-gray-800 truncate">{doc.file_name}</p>
                        <IdentificationChip meta={findIdMeta(doc)} />
                      </div>
                    </div>
                    {doc.file_url ? (
                      <div className="flex items-center gap-1 shrink-0 ml-3">
                        <a
                          href={docDownloadHref(doc.file_url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:text-[#C10007] hover:bg-white transition-colors"
                          title="View"
                          aria-label={`View ${doc.file_name ?? "file"}`}
                        >
                          <Eye size={16} />
                        </a>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            downloadDocFile(doc);
                          }}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:text-[#C10007] hover:bg-white transition-colors"
                          title="Download"
                          aria-label={`Download ${doc.file_name ?? "file"}`}
                        >
                          <Download size={16} />
                        </button>
                        {taskDocsPopup.isAps && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleApsDocFileDelete(doc.file_url);
                            }}
                            disabled={deletingApsDocUrl === doc.file_url}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:text-[#C10007] hover:bg-white transition-colors disabled:opacity-50"
                            title="Delete"
                            aria-label={`Delete ${doc.file_name ?? "file"}`}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400 shrink-0 ml-3">No file</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setTaskDocsPopup(null)}
                className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Task Modal — hidden while a sub-drawer (identification / home
          insurance / clone-from-previous) is open so the two popups don't
          visually overlap. */}
      {editingTask && !idDrawerTaskId && !homeInsDrawerTaskId && !cloneDrawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit Task"
          className="fixed inset-0 z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
          onClick={() => { if (!editTaskSaving) closeEditTask(); }}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Edit Task</h3>
                <p className="text-xs text-gray-400 mt-1">Update task details and client responses.</p>
              </div>
              <button
                onClick={closeEditTask}
                disabled={editTaskSaving}
                className="text-gray-400 hover:text-gray-700 disabled:opacity-50 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
              <div>
                <label className="text-sm font-semibold text-gray-800 block mb-2">
                  Task Name <span className="text-[#C10007]">*</span>
                </label>
                <input
                  type="text"
                  value={editTaskTitle}
                  onChange={(e) => setEditTaskTitle(e.target.value)}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Status
                  </label>
                  <select
                    value={editTaskStatus}
                    onChange={(e) => setEditTaskStatus(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  >
                    <option value="Pending">Pending</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Due Date
                  </label>
                  <input
                    type="date"
                    min="1900-01-01"
                    max="2100-12-31"
                    value={editTaskDueDate}
                    onChange={(e) => setEditTaskDueDate(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Completed At
                  </label>
                  <input
                    type="date"
                    min="1900-01-01"
                    max="2100-12-31"
                    value={editTaskCompletedAt}
                    onChange={(e) => setEditTaskCompletedAt(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Milestone
                  </label>
                  <select
                    value={editTaskMilestoneId}
                    onChange={(e) => setEditTaskMilestoneId(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                  >
                    <option value="">— None —</option>
                    {milestones.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Client-submitted responses — text fields editable; file rows
                  can be removed and (for APS tasks) re-uploaded right here
                  via the APS upload modal, which replaces the existing doc
                  family-wide and re-bridges it into this task. */}
              <div className="border-t border-gray-100 pt-5">
                <div className="flex items-center justify-between mb-3 gap-3">
                  <p className="text-sm font-semibold text-gray-800">
                    Client Responses
                  </p>
                  <div className="flex items-center gap-2">
                  {editingTask && isCloneableTask(editingTask) && (
                    <button
                      type="button"
                      onClick={() => openCloneDrawerFor(primaryLeadId)}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-[#C10007] bg-white border border-[#C10007] rounded-lg hover:bg-[#FEF2F2]"
                      title="Prefill personal fields and identification documents from a previous deal for this client"
                    >
                      <Copy size={14} />
                      Clone from previous deal
                    </button>
                  )}
                  {editingTask && isIdentificationTask(editingTask) && (
                    <button
                      type="button"
                      onClick={() => openIdDrawerFor(primaryLeadId, editingTask.id)}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#C10007] rounded-lg hover:bg-[#a30006]"
                    >
                      <Upload size={14} />
                      {editTaskIdDocs.length > 0
                        ? "Upload More / Replace"
                        : "Upload Identification Documents"}
                    </button>
                  )}
                  {editingTask && isHomeInsuranceTask(editingTask) && (() => {
                    const fileField = editTaskFormFields.find(
                      (f) => f.field_type === "file",
                    );
                    const existing = editTaskResponses.find((r) => {
                      if (r.field_type !== "file" || !r.file_url || r.deleted) return false;
                      if (fileField?.id && r.field_id === fileField.id) return true;
                      if (fileField?.label && r.field_label === fileField.label) return true;
                      return !fileField; // legacy task with no template — match any file response
                    });
                    return (
                      <button
                        type="button"
                        onClick={() => setHomeInsDrawerTaskId(editingTask.id)}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#C10007] rounded-lg hover:bg-[#a30006]"
                      >
                        <Upload size={14} />
                        {existing
                          ? "Replace Home Insurance Policy"
                          : "Upload Home Insurance Policy"}
                      </button>
                    );
                  })()}
                  </div>
                </div>
                {editTaskLoading ? (
                  <div className="flex items-center gap-2 py-3">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#C10007]" />
                    <span className="text-xs text-gray-400">Loading…</span>
                  </div>
                ) : editingTask && isIdentificationTask(editingTask) ? (
                  // Identification task — reuse the dedicated upload drawer
                  // (AI classification, camera, expiry, dedup) and list any
                  // docs the client (or admin) has already saved.
                  <div className="space-y-3">
                    {editTaskIdDocsLoading ? (
                      <p className="text-xs text-gray-400 italic">Loading documents…</p>
                    ) : editTaskIdDocs.length > 0 ? (
                      editTaskIdDocs.map((doc) => (
                        <div
                          key={doc.id}
                          className="bg-gray-50 rounded-lg px-4 py-3 flex items-start justify-between gap-2"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-gray-800">
                              {formatIdDocLabel(doc.custom_type)}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <FileText size={14} className="text-[#C10007] shrink-0" />
                              {doc.file_url ? (
                                <a
                                  href={docDownloadHref(doc.file_url)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm text-[#C10007] hover:underline truncate"
                                >
                                  {doc.file_name || "View file"}
                                </a>
                              ) : (
                                <span className="text-sm text-gray-500 truncate">
                                  {doc.file_name || "—"}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-gray-400 italic">
                        No identification documents uploaded yet.
                      </p>
                    )}
                  </div>
                ) : editTaskFormFields.length > 0 ? (
                  // Template defines a form: render one row per field, pre-
                  // filled with any existing response (matched by field_id).
                  // Empty rows let the admin fill in on the client's behalf.
                  <div className="space-y-3">
                    {/* Full Name — read-only, mirroring the portal. It lives on
                        the client record, not this template, so it is not
                        editable here; name changes go through the client's
                        name-change request. */}
                    {editingTask && isPersonalInfoTask(editingTask) && personalInfoFullName(editingTask) && (
                      <div className="bg-gray-50 rounded-lg px-4 py-3 opacity-90">
                        <p className="text-xs font-semibold text-gray-800">
                          Full Name
                          <span className="ml-2 font-medium text-gray-400">(read-only)</span>
                        </p>
                        <p className="text-sm text-gray-700 mt-1 break-words">
                          {personalInfoFullName(editingTask)}
                        </p>
                      </div>
                    )}
                    {editTaskFormFields.map((field) => {
                      const resp = findResponseForField(field);
                      const currentValue = resp?.value ?? "";
                      const isFile = field.field_type === "file";
                      // A file field can have multiple files (e.g. APS).
                      const fieldResponses = isFile ? findResponsesForField(field) : [];
                      const respId = resp?.id ?? null;
                      const isTempResp = respId?.startsWith("tmp-") ?? false;
                      const isPersistedDeleted = Boolean(resp?.deleted);
                      const isMailForwardingStart =
                        (field.label || "").trim().toLowerCase() === "street address";
                      return (
                        <React.Fragment key={field.id}>
                        {isMailForwardingStart && (
                          <p className="text-sm font-semibold text-gray-800">Mail forwarding address</p>
                        )}
                        <div
                          className={`bg-gray-50 rounded-lg px-4 py-3 ${isPersistedDeleted ? "opacity-40" : ""}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-semibold text-gray-800">
                              {field.label}
                              {field.required ? <span className="text-[#C10007] ml-1">*</span> : null}
                            </p>
                            {/* Per-field file action. For APS tasks it opens
                                the APS upload modal, which APPENDS more files
                                (agreement + amendments) — so it always reads
                                "Add"; for non-APS it replaces/uploads via the
                                generic file-PATCH path. */}
                            {isFile && !(editingTask && isHomeInsuranceTask(editingTask)) && (
                              isEditingApsTask ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setApsFiles([]);
                                    setApsUploadSide(null);
                                    setShowApsUpload(true);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-[#C10007] border border-[#C10007] rounded hover:bg-[#FEF2F2] disabled:opacity-50"
                                  title="Add more files"
                                >
                                  <Upload size={12} /> Add
                                </button>
                              ) : fieldResponses.length > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => triggerReplaceFile(fieldResponses[0].id)}
                                  disabled={replacingFileBusy === fieldResponses[0].id}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-[#C10007] border border-[#C10007] rounded hover:bg-[#FEF2F2] disabled:opacity-50"
                                  title="Replace file"
                                >
                                  <Upload size={12} />
                                  {replacingFileBusy === fieldResponses[0].id ? "Uploading…" : "Replace"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => triggerUploadFile(field)}
                                  disabled={replacingFileBusy === `field-${field.id}`}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-white bg-[#C10007] rounded hover:bg-[#a30006] disabled:opacity-50"
                                  title="Upload file"
                                >
                                  <Upload size={12} />
                                  {replacingFileBusy === `field-${field.id}` ? "Uploading…" : "Upload"}
                                </button>
                              )
                            )}
                          </div>
                          {/* Field input by type */}
                          {isFile ? (
                            fieldResponses.length > 0 ? (
                              <div className="mt-1 space-y-2">
                                {fieldResponses.map((r) => (
                                  <div key={r.id} className="flex items-center gap-2">
                                    <FileText size={14} className="text-[#C10007] shrink-0" />
                                    {r.file_url ? (
                                      <a
                                        href={docDownloadHref(r.file_url)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sm text-[#C10007] hover:underline truncate"
                                      >
                                        {r.file_name || "View file"}
                                      </a>
                                    ) : (
                                      <span className="text-sm text-gray-500 truncate">{r.file_name}</span>
                                    )}
                                    {/* Per-file delete for APS — removes just
                                        this file from lead_corporate_docs +
                                        task_responses. */}
                                    {isEditingApsTask && r.file_url && (
                                      <button
                                        type="button"
                                        onClick={() => handleApsDocFileDelete(r.file_url)}
                                        disabled={deletingApsDocUrl === r.file_url}
                                        className="text-gray-400 hover:text-[#C10007] disabled:opacity-50 shrink-0 ml-auto"
                                        title="Delete this file"
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-gray-400 italic mt-2">
                                No file uploaded. Use the Upload button to add one.
                              </p>
                            )
                          ) : field.field_type === "textarea" ? (
                            <textarea
                              value={currentValue}
                              placeholder={field.placeholder ?? ""}
                              onChange={(e) => setFieldValue(field, e.target.value)}
                              rows={3}
                              className="mt-2 w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                            />
                          ) : field.field_type === "select" ? (
                            <select
                              value={currentValue}
                              onChange={(e) => setFieldValue(field, e.target.value)}
                              className="mt-2 w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                            >
                              <option value="">— Select —</option>
                              {parseFieldOptions(field.options).map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          ) : field.field_type === "checkbox" ? (
                            <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                              <input
                                type="checkbox"
                                checked={currentValue === "true" || currentValue === "1" || currentValue === "yes"}
                                onChange={(e) => setFieldValue(field, e.target.checked ? "true" : "false")}
                                className="rounded border-gray-300 text-[#C10007] focus:ring-[#C10007]"
                              />
                              {field.placeholder || "Yes"}
                            </label>
                          ) : (
                            (() => {
                              // Treat any field labelled "...phone..." as a
                              // phone input even when the DB has field_type
                              // set to "text" — same fallback the validator
                              // uses, so the formatter, placeholder and tel
                              // keypad all stay consistent with validation.
                              const labelMentionsPhone = (field.label ?? "")
                                .toLowerCase()
                                .includes("phone");
                              const isPhone =
                                field.field_type === "phone" || labelMentionsPhone;
                              const isPostal = isPostalField(field);
                              const formatter = isPhone
                                ? formatPhoneAsTyped
                                : isPostal
                                ? formatPostalAsTyped
                                : null;
                              const displayValue = formatter ? formatter(currentValue) : currentValue;
                              const defaultPlaceholder = isPhone
                                ? "(416) 555-1234"
                                : isPostal
                                ? "M5V 3L9"
                                : "";
                              return (
                                <input
                                  type={
                                    field.field_type === "date"
                                      ? "date"
                                      : field.field_type === "email"
                                      ? "email"
                                      : isPhone
                                      ? "tel"
                                      : field.field_type === "number"
                                      ? "number"
                                      : "text"
                                  }
                                  inputMode={
                                    isPhone
                                      ? "tel"
                                      : field.field_type === "number"
                                      ? "numeric"
                                      : undefined
                                  }
                                  maxLength={
                                    isPhone ? 14 : isPostal ? 7 : undefined
                                  }
                                  value={displayValue}
                                  placeholder={field.placeholder ?? defaultPlaceholder}
                                  onChange={(e) =>
                                    setFieldValue(
                                      field,
                                      formatter ? formatter(e.target.value) : e.target.value,
                                    )
                                  }
                                  className="mt-2 w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                                />
                              );
                            })()
                          )}
                          {/* Inline validation error */}
                          {editTaskFieldErrors[field.id] && (
                            <p className="mt-1 text-[11px] text-[#C10007]">
                              {editTaskFieldErrors[field.id]}
                            </p>
                          )}
                          {/* Show the persisted-state hint so admin knows
                              if their edit will create a new row or update. */}
                          {!isFile && resp && !isTempResp && !editTaskFieldErrors[field.id] && (
                            <p className="mt-1 text-[10px] text-gray-400">Existing response — saving will update it.</p>
                          )}
                          {!isFile && isTempResp && currentValue !== "" && !editTaskFieldErrors[field.id] && (
                            <p className="mt-1 text-[10px] text-emerald-600">
                              {(() => {
                                const leadKey = getLeadFieldKeyForLabel(field.label);
                                if (leadKey) {
                                  return "Pre-filled from lead. Saving will store this response and update the lead.";
                                }
                                return "New response — saving will add it.";
                              })()}
                            </p>
                          )}
                        </div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                ) : editTaskResponses.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">
                    {isEditingApsTask
                      ? "No APS document uploaded yet. Use the button above to upload one."
                      : "No responses submitted yet."}
                  </p>
                ) : (
                  // Fallback: no form-field schema (legacy task without a
                  // template) — keep the old row-per-response renderer so
                  // admins can still edit/delete existing client submissions.
                  <div className="space-y-3">
                    {editTaskResponses.map((resp) => (
                      <div
                        key={resp.id}
                        className={`bg-gray-50 rounded-lg px-4 py-3 ${resp.deleted ? "opacity-40" : ""}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-semibold text-gray-800">
                            {resp.field_label || resp.field_id || "Response"}
                          </p>
                          {!resp.deleted && (
                            resp.field_type === "file" ? (
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (isEditingApsTask) {
                                      setApsFiles([]);
                                      setApsUploadSide(null);
                                      setShowApsUpload(true);
                                    } else {
                                      triggerReplaceFile(resp.id);
                                    }
                                  }}
                                  disabled={replacingFileBusy === resp.id}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-[#C10007] border border-[#C10007] rounded hover:bg-[#FEF2F2] disabled:opacity-50"
                                  title={isEditingApsTask ? "Add more files" : "Replace file"}
                                >
                                  <Upload size={12} />
                                  {replacingFileBusy === resp.id
                                    ? "Uploading…"
                                    : isEditingApsTask
                                      ? "Add"
                                      : "Replace"}
                                </button>
                                {/* Per-file delete for APS — removes just this
                                    file from lead_corporate_docs + task_responses. */}
                                {isEditingApsTask && resp.file_url && (
                                  <button
                                    type="button"
                                    onClick={() => handleApsDocFileDelete(resp.file_url)}
                                    disabled={deletingApsDocUrl === resp.file_url}
                                    className="text-gray-400 hover:text-[#C10007] disabled:opacity-50"
                                    title="Delete this file"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => markResponseDeleted(resp.id)}
                                className="text-gray-400 hover:text-[#C10007]"
                                title="Remove this response"
                              >
                                <Trash2 size={14} />
                              </button>
                            )
                          )}
                        </div>
                        {resp.field_type === "file" ? (
                          <div className="flex items-center gap-2 mt-1">
                            <FileText size={14} className="text-[#C10007] shrink-0" />
                            {resp.file_url ? (
                              <a
                                href={docDownloadHref(resp.file_url)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm text-[#C10007] hover:underline truncate"
                              >
                                {resp.file_name || "View file"}
                              </a>
                            ) : (
                              <span className="text-sm text-gray-500">
                                {resp.file_name || "File uploaded (no URL)"}
                              </span>
                            )}
                          </div>
                        ) : (
                          <input
                            type="text"
                            value={resp.value ?? ""}
                            onChange={(e) => updateResponseValue(resp.id, e.target.value)}
                            disabled={resp.deleted}
                            className="mt-2 w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white disabled:bg-gray-100"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={closeEditTask}
                disabled={editTaskSaving}
                className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveEditTask}
                disabled={editTaskSaving}
                className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-50"
              >
                {editTaskSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
            <input
              ref={replacingFileInputRef}
              type="file"
              accept="application/pdf,image/jpeg,image/jpg,image/png"
              hidden
              onChange={handleReplaceFilePicked}
            />
          </div>
        </div>
      )}

      {/* View Task Detail Modal */}
      {viewingTask && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Task Details"
          className="fixed inset-0 z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
          onClick={() => setViewingTask(null)}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Task Details</h3>
                <p className="text-xs text-gray-400 mt-1">Review task information and client responses.</p>
              </div>
              <button
                onClick={() => setViewingTask(null)}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
              <div>
                <p className="text-sm font-semibold text-gray-800">Task Name</p>
                <p className="text-sm text-gray-700 mt-1">{viewingTask.title}</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-semibold text-gray-800">Status</p>
                  <span className={`inline-block mt-1 text-xs font-semibold border rounded px-2 py-1 ${getStatusColor(viewingTask.status || "Pending")}`}>
                    {viewingTask.status || "Pending"}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">Due Date</p>
                  <p className="text-sm text-gray-700 mt-1">
                    {viewingTask.dueDate
                      ? formatLocalDate(viewingTask.dueDate)
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">Completed At</p>
                  <p className="text-sm text-gray-700 mt-1">
                    {viewingTask.completedAt
                      ? formatLocalDateTime(viewingTask.completedAt)
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">Milestone</p>
                  <p className="text-sm text-gray-700 mt-1">
                    {viewingTask.milestoneId
                      ? milestones.find((m) => m.id === viewingTask.milestoneId)?.title || "—"
                      : "—"}
                  </p>
                </div>
              </div>

              {/* Client-submitted responses */}
              <div className="border-t border-gray-100 pt-5">
                <p className="text-sm font-semibold text-gray-800 mb-3">Client Responses</p>
                {loadingTaskResponses ? (
                  <div className="flex items-center gap-2 py-4">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#C10007]"></div>
                    <span className="text-xs text-gray-400">Loading...</span>
                  </div>
                ) : viewTaskResponses.length > 0 ? (
                  <div className="space-y-3">
                    {/* Full Name — shown by the portal at the top of this task
                        but sourced from the client record, so it has no
                        response row of its own. */}
                    {viewingTask && isPersonalInfoTask(viewingTask) && personalInfoFullName(viewingTask) && (
                      <div className="bg-gray-50 rounded-lg px-4 py-3">
                        <p className="text-xs font-semibold text-gray-800">Full Name</p>
                        <p className="text-sm text-gray-700 mt-1 break-words">
                          {personalInfoFullName(viewingTask)}
                        </p>
                      </div>
                    )}
                    {viewTaskResponses.map((resp: any, i: number) => {
                      const isMailForwardingStart =
                        (resp.field_label || "").trim().toLowerCase() === "street address";
                      return (
                      <React.Fragment key={i}>
                        {isMailForwardingStart && (
                          <p className="text-sm font-semibold text-gray-800">Mail forwarding address</p>
                        )}
                        <div className="bg-gray-50 rounded-lg px-4 py-3">
                        <p className="text-xs font-semibold text-gray-800">
                          {resp.field_label || resp.field_id || `Field ${i + 1}`}
                        </p>
                        {resp.field_type === "file" ? (
                          <div className="flex items-center gap-2 mt-1">
                            <FileText size={14} className="text-[#C10007] shrink-0" />
                            {resp.file_url ? (
                              <a href={docDownloadHref(resp.file_url)} target="_blank" rel="noopener noreferrer" className="text-sm text-[#C10007] hover:underline truncate">
                                {resp.file_name || "View file"}
                              </a>
                            ) : (
                              <span className="text-sm text-gray-500">{resp.file_name || "File uploaded (no URL)"}</span>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-700 mt-1 break-words">
                            {resp.value || resp.text_value || "—"}
                          </p>
                        )}
                        </div>
                      </React.Fragment>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 italic">No responses submitted yet.</p>
                )}
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setViewingTask(null)}
                className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Identification upload drawer — admin-side reuse of the client drawer.
          When the viewer is on the PRIMARY's deal, a "Uploading for" person
          selector is shown inside the drawer so the primary can pick which
          family member's ID this upload belongs to. Switching person remounts
          the drawer (via key) so staged-file/detection state resets. */}
      {(() => {
        const isPrimaryView = ((rawDeal?.current_deal_role as string | undefined) ?? "")
          .toLowerCase()
          .startsWith("primary") || !rawDeal?.current_deal_role;
        const primaryName = [rawDeal?.lead_first_name, rawDeal?.lead_last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || "Primary";
        type Opt = { leadId: string; taskId: string; name: string; role: string; completed: boolean };
        const opts: Opt[] = [];
        const primaryTaskId = rawDeal?.identification_task_id as string | undefined;
        if (isPrimaryView && primaryLeadId && primaryTaskId) {
          opts.push({
            leadId: primaryLeadId,
            taskId: primaryTaskId,
            name: primaryName,
            role: (rawDeal?.current_deal_role as string | undefined) ?? "Primary",
            completed: (rawDeal?.identification_status as string | undefined) === "Completed",
          });
        }
        if (isPrimaryView) {
          for (const ld of (rawDeal?.linked_deals ?? []) as any[]) {
            if (ld.lead_id && ld.identification_task_id) {
              opts.push({
                leadId: ld.lead_id as string,
                taskId: ld.identification_task_id as string,
                name: (ld.lead_name as string) || "Family member",
                role: (ld.role as string) || "Co-Client",
                completed: ld.identification_status === "Completed",
              });
            }
          }
        }
        return (
          <UploadIdentificationDrawer
            key={idDrawerLeadId}
            open={!!idDrawerTaskId}
            onClose={() => {
              setIdDrawerTaskId(null);
              setIdDrawerLeadId(primaryLeadId);
            }}
            leadId={idDrawerLeadId}
            taskId={idDrawerTaskId ?? undefined}
            personOptions={isPrimaryView && opts.length > 1 ? opts : undefined}
            onPersonChange={(newLeadId, newTaskId) => {
              setIdDrawerLeadId(newLeadId);
              setIdDrawerTaskId(newTaskId);
            }}
            onSaved={() => {
              setIdDrawerTaskId(null);
              setIdDrawerLeadId(primaryLeadId);
              if (editingTask && isIdentificationTask(editingTask)) {
                void fetchEditTaskIdDocs();
              } else if (typeof window !== "undefined") {
                window.location.reload();
              }
            }}
          />
        );
      })()}

      {/* Single-party Personal Info modal — matches the customer portal's
          PersonalInfoTaskDrawer. Opened per-person from a "Provide Personal
          Information" task row (no multi-party accordion). */}
      <CoPersonPersonalInfoModal
        open={!!personalInfoModal}
        onClose={() => {
          const changed = personalInfoChanged;
          setPersonalInfoModal(null);
          setPersonalInfoChanged(false);
          // Reflect any completion in the page's task list / statuses.
          if (changed && typeof window !== "undefined") window.location.reload();
        }}
        coPerson={personalInfoModal}
        onSaved={() => setPersonalInfoChanged(true)}
      />

      {/* Clone-from-previous drawer — lets admin pick a prior deal for the
          same client (matched by email) and prefill personal fields +
          reuse identification docs by reference. */}
      <ClonePreviousDealDrawer
        open={cloneDrawerOpen}
        onClose={() => setCloneDrawerOpen(false)}
        leadId={cloneDrawerLeadId}
        onApplied={() => {
          if (typeof window !== "undefined") {
            window.location.reload();
          }
        }}
      />

      {/* Home Insurance upload drawer — admin-side reuse of the client drawer */}
      {(() => {
        const fileField =
          editingTask && isHomeInsuranceTask(editingTask)
            ? editTaskFormFields.find((f) => f.field_type === "file")
            : undefined;
        const existing =
          editingTask && isHomeInsuranceTask(editingTask)
            ? editTaskResponses.find((r) => {
                if (r.field_type !== "file" || !r.file_url || r.deleted) return false;
                if (fileField?.id && r.field_id === fileField.id) return true;
                if (fileField?.label && r.field_label === fileField.label) return true;
                return !fileField;
              })
            : undefined;
        return (
          <UploadHomeInsuranceDrawer
            open={!!homeInsDrawerTaskId}
            onClose={() => setHomeInsDrawerTaskId(null)}
            leadId={idDrawerLeadId}
            taskId={homeInsDrawerTaskId ?? undefined}
            existingResponseId={existing?.id ?? null}
            fieldId={fileField?.id ?? null}
            fieldLabel={fileField?.label ?? null}
            onSaved={() => {
              setHomeInsDrawerTaskId(null);
              if (editingTask) void refreshEditTaskResponses();
            }}
          />
        );
      })()}
    </div>
  );
};

export default DealDetail;
