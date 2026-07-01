"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NextImage from "next/image";
import Webcam from "react-webcam";
import {
  X,
  Upload,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Camera,
  RotateCcw,
  ArrowRight,
  ChevronDown,
  FileText,
  Trash2,
  Plus,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Clock,
  IdCard,
} from "lucide-react";
import Button from "@/components/ui/Button";
import { useIsLargeScreen } from "@/hooks/useMediaQuery";

interface UploadIdentificationDrawerProps {
  open: boolean;
  onClose: () => void;
  leadId?: string;
  taskId?: string;
  onSaved?: () => void;
  /**
   * Optional "upload on behalf of" selector. When provided with more than one
   * option, renders a dropdown at the top of the drawer so the primary can
   * switch which family member this upload belongs to. Selecting a different
   * person calls `onPersonChange` — the parent is expected to update the
   * `leadId`/`taskId` props and remount the drawer (via a `key`) so the
   * staged-file/detection state resets cleanly.
   */
  personOptions?: Array<{
    leadId: string;
    taskId: string;
    name: string;
    role: string;
    completed: boolean;
  }>;
  onPersonChange?: (leadId: string, taskId: string) => void;
  /**
   * When true, renders only the form body + footer (no backdrop, header, modal
   * chrome, scroll-lock or Escape handling) so it can be embedded inside the
   * multi-party accordion (AdminMultiPartyTaskDrawer), which owns that chrome.
   */
  embedded?: boolean;
}

// ── Camera slot model (used only by the guided camera flow) ───────────────────

type SlotKey = "primaryFront" | "primaryBack" | "secondaryFront" | "secondaryBack";

const SLOT_LABELS: Record<SlotKey, string> = {
  primaryFront: "First ID - Front",
  primaryBack: "First ID - Back",
  secondaryFront: "Second ID - Front",
  secondaryBack: "Second ID - Back",
};

const SLOT_CUSTOM_TYPES: Record<SlotKey, LabelKey> = {
  primaryFront: "primary_front",
  primaryBack: "primary_back",
  secondaryFront: "secondary_front",
  secondaryBack: "secondary_back",
};

const ALL_CAMERA_STEPS: SlotKey[] = ["primaryFront", "primaryBack", "secondaryFront", "secondaryBack"];
const SECONDARY_CAMERA_STEPS: SlotKey[] = ["secondaryFront", "secondaryBack"];

// ── Manual upload model (list of selected files with labels) ─────────────────

type LabelKey = "primary_front" | "primary_back" | "secondary_front" | "secondary_back" | "other";

type ExpiryStatus = "valid" | "expired" | "expiring_soon" | "unknown";

interface DocumentEntry {
  documentType: string;
  side: "front" | "back" | "front-and-back" | "unknown";
  sideRequirement: "single-sided" | "front-and-back" | "unknown";
  isComplete: boolean;
  confidence: "high" | "medium" | "low";
  expiryDate: string | null;
  expiryStatus: ExpiryStatus;
}

interface DetectionResult {
  isIdentification: boolean;
  documentType: string | null;
  side: "front" | "back" | "front-and-back" | "unknown";
  sideRequirement: "single-sided" | "front-and-back" | "unknown";
  confidence: "high" | "medium" | "low";
  reason: string;
  expiryDate: string | null;
  expiryStatus: ExpiryStatus;
  // Multi-document support
  multipleDocuments?: DocumentEntry[];
  summary?: {
    totalDocuments: number;
    completeDocuments: number;
    documentTypesFound: string[];
  };
}

interface SelectedFile {
  id: string;
  file: File;
  previewUrl: string | null;
  error: string | null;
  label: LabelKey;
  detecting: boolean;
  detection: DetectionResult | null;
  detectionError: string | null;
  isDuplicate: boolean;
  duplicateReason: string | null;
  fromCamera: boolean;
  // SHA-256 hash of the file's bytes. Used to detect *exact* duplicate uploads
  // (e.g. the same passport image uploaded twice) without flagging two
  // different files that happen to share a filename or byte size.
  contentHash: string | null;
}

interface ExistingDoc {
  id: string;
  file_name: string | null;
  file_url: string | null;
  custom_type: string | null;
  created_at: string | null;
}

const DOC_TYPE = "identification";
const ALLOWED_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".heic"];
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// Acceptable ID types that users can manually select when AI classification fails
const ACCEPTABLE_ID_TYPES = [
  "Canadian Passport",
  "Driver's License",
  "Canadian Citizenship Card",
  "Permanent Resident Card",
  "NEXUS Card",
  "SIN Card (plastic only)",
  "Foreign Passport",
  "Government-issued Photo ID Card",
];

// IDs that only need a single side (info page)
const SINGLE_SIDED_IDS = ["Canadian Passport", "Foreign Passport"];

type ManualSide = "front" | "back" | "front-and-back";

const LABEL_OPTIONS: { value: LabelKey; text: string }[] = [
  { value: "primary_front", text: "Primary ID - Front" },
  { value: "primary_back", text: "Primary ID - Back" },
  { value: "secondary_front", text: "Secondary ID - Front" },
  { value: "secondary_back", text: "Secondary ID - Back" },
  { value: "other", text: "Other" },
];

const DEFAULT_ORDER: LabelKey[] = [
  "primary_front",
  "primary_back",
  "secondary_front",
  "secondary_back",
];

function labelText(label: LabelKey) {
  return LABEL_OPTIONS.find((o) => o.value === label)?.text ?? "Other";
}

function validateFile(f: File): string | null {
  const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) return "Only PDF, JPG, PNG, or HEIC files are allowed.";
  if (f.size > MAX_SIZE) return "File size must not exceed 10 MB.";
  return null;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImageFile(f: File) {
  return f.type.startsWith("image/");
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Compute a SHA-256 content hash for the given file. Two files with the same
// hash are bit-for-bit identical; two different files (even with the same name
// and byte size) will produce different hashes.
async function computeFileContentHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function computeImageSharpnessScore(dataUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const size = 360;
      const srcSide = Math.min(img.width, img.height);
      const sx = (img.width - srcSide) / 2;
      const sy = (img.height - srcSide) / 2;

      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Unable to process image."));
        return;
      }

      ctx.drawImage(img, sx, sy, srcSide, srcSide, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      let sum = 0;
      let sumSq = 0;
      let count = 0;

      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          const i = (y * size + x) * 4;
          const right = (y * size + (x + 1)) * 4;
          const down = ((y + 1) * size + x) * 4;

          const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          const grayR = 0.299 * data[right] + 0.587 * data[right + 1] + 0.114 * data[right + 2];
          const grayD = 0.299 * data[down] + 0.587 * data[down + 1] + 0.114 * data[down + 2];

          const gx = gray - grayR;
          const gy = gray - grayD;
          const magnitude = gx * gx + gy * gy;
          sum += magnitude;
          sumSq += magnitude * magnitude;
          count++;
        }
      }

      if (!count) {
        resolve(0);
        return;
      }

      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      resolve(variance);
    };
    img.onerror = () => reject(new Error("Unable to read captured image."));
    img.src = dataUrl;
  });
}

async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const blob = await fetch(dataUrl).then((r) => r.blob());
  return new File([blob], filename, { type: "image/jpeg" });
}

type DetectionFetchResult =
  | { ok: true; detection: DetectionResult }
  | { ok: false; error: string };

async function fetchDetection(file: File, timeoutMs = 50_000): Promise<DetectionFetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/admin/identify-document", {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
    const data = await res
      .json()
      .catch(() => ({ success: false, error: "Invalid response from server." }));
    if (!data.success) {
      return { ok: false, error: data.error ?? "Detection failed." };
    }
    const r = data.result as {
      is_identification: boolean;
      document_type: string | null;
      side: "front" | "back" | "front-and-back" | "unknown";
      side_requirement: "single-sided" | "front-and-back" | "unknown";
      confidence: "high" | "medium" | "low";
      reason: string;
      expiry_date: string | null;
      expiry_status: ExpiryStatus;
      multiple_documents?: Array<{
        document_type: string;
        side: "front" | "back" | "front-and-back" | "unknown";
        side_requirement: "single-sided" | "front-and-back" | "unknown";
        is_complete: boolean;
        confidence: "high" | "medium" | "low";
        expiry_date: string | null;
        expiry_status: ExpiryStatus;
      }>;
      summary?: {
        total_documents: number;
        complete_documents: number;
        document_types_found: string[];
      };
    };

    const multipleDocuments = r.multiple_documents?.map((d) => ({
      documentType: d.document_type,
      side: d.side,
      sideRequirement: d.side_requirement,
      isComplete: d.is_complete,
      confidence: d.confidence,
      expiryDate: d.expiry_date ?? null,
      expiryStatus: d.expiry_status ?? "unknown",
    }));

    const summary = r.summary ? {
      totalDocuments: r.summary.total_documents,
      completeDocuments: r.summary.complete_documents,
      documentTypesFound: r.summary.document_types_found,
    } : undefined;

    return {
      ok: true,
      detection: {
        isIdentification: r.is_identification,
        documentType: r.document_type,
        side: r.side,
        sideRequirement: r.side_requirement ?? "unknown",
        confidence: r.confidence,
        reason: r.reason,
        expiryDate: r.expiry_date ?? null,
        expiryStatus: r.expiry_status ?? "unknown",
        multipleDocuments,
        summary,
      },
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Document verification is taking longer than expected. Please try again with a clearer image or smaller file size."
        : err instanceof Error
          ? err.message
          : "Detection failed.";
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

function appendDetectionFields(fd: FormData, det: DetectionResult | null) {
  if (!det) return;
  fd.append("is_identification", det.isIdentification ? "true" : "false");
  if (det.documentType) fd.append("document_type", det.documentType);
  fd.append("side", det.side);
  fd.append("side_requirement", det.sideRequirement);
  fd.append("confidence", det.confidence);
  if (det.reason) fd.append("detection_reason", det.reason);
}

// ── Acceptable Documents Section (LSO By-Law 7.1) ────────────────────────────

function AcceptableDocumentsSection() {
  const acceptableDocs = [
    "Canadian Passport",
    "Driver's License",
    "Canadian Citizenship Card",
    "Permanent Resident Card",
    "NEXUS Card",
    "SIN Card (plastic only)",
    "Foreign Passport",
    "Government-issued Photo ID Card",
  ];

  return (
    <div className="rounded-xl border border-[#C10007]/20 bg-[#FEF2F2] overflow-hidden">
      <div className="px-4 py-3.5 border-b border-[#C10007]/10">
        <span className="text-sm font-bold text-gray-900">
          Acceptable Identification Documents
        </span>
      </div>
      <div className="px-4 py-4 bg-white space-y-4">
        <p className="text-xs text-gray-600 leading-relaxed">
          Please provide{" "}
          <span className="font-bold text-[#C10007]">two different government-issued photo IDs</span>{" "}
          from the list below for identity verification.
        </p>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {acceptableDocs.map((doc) => (
            <div key={doc} className="flex items-center gap-2 text-xs text-gray-700">
              <CheckCircle2 size={13} className="text-green-500 flex-shrink-0" />
              <span>{doc}</span>
            </div>
          ))}
        </div>

        <div className="flex items-start gap-2 pt-3 border-t border-gray-100">
          <AlertCircle size={13} className="text-[#C10007] flex-shrink-0 mt-0.5" />
          <p className="text-xs text-gray-500">
            <span className="font-semibold text-gray-700">Note:</span> Health cards are not valid
            government ID for these purposes.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Why Identification Required Dropdown ───────────────────────────────────────

function WhyIdentificationRequiredDropdown() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors cursor-pointer"
      >
        <span className="text-sm font-medium text-gray-700">
          Why is Identification Required?
        </span>
        <ChevronDown
          size={18}
          className={`text-gray-400 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      {isOpen && (
        <div className="px-4 py-3 bg-white border-t border-gray-100 space-y-2 text-xs text-gray-600 leading-relaxed">
          <p>
            Government-issued identification is required to verify your identity and comply with
            legal requirements for property transactions.
          </p>
          <p>
            This helps prevent fraud and ensures all parties are properly identified before
            proceeding with the closing.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function UploadIdentificationDrawer({
  open,
  onClose,
  leadId,
  taskId,
  onSaved,
  personOptions,
  onPersonChange,
  embedded = false,
}: UploadIdentificationDrawerProps) {
  const isLargeScreen = useIsLargeScreen();
  // Manual upload state
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const [existing, setExisting] = useState<ExistingDoc[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<SelectedFile[]>([]);
  const verificationStatusRef = useRef<HTMLDivElement>(null);

  // Keep selectedRef in sync so detection callbacks can read the current file name
  // without being inside a setState updater
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Error modal state - simplified unified error popup
  type ErrorKind = "invalid_id" | "expired" | "unable_to_process" | "invalid_file_type" | "file_too_large" | "resolution_issue";
  
  const [errorModal, setErrorModal] = useState<{
    open: boolean;
    fileId: string;
    fileName: string;
    kind: ErrorKind;
    documentType?: string;
    expiryDate?: string;
    customReason?: string;
  }>({ open: false, fileId: "", fileName: "", kind: "invalid_id" });

  type ErrorModalPayload = {
    fileId: string;
    fileName: string;
    kind: ErrorKind;
    documentType?: string;
    expiryDate?: string;
    customReason?: string;
  };

  const errorModalQueueRef = useRef<ErrorModalPayload[]>([]);
  const errorModalOpenRef = useRef(false);

  function openErrorModal(payload: ErrorModalPayload) {
    if (errorModalOpenRef.current) {
      errorModalQueueRef.current.push(payload);
      return;
    }
    errorModalOpenRef.current = true;
    setErrorModal({ ...payload, open: true });
  }

  function closeErrorModal() {
    errorModalOpenRef.current = false;
    setErrorModal({
      open: false,
      fileId: "",
      fileName: "",
      kind: "invalid_id",
    });
    const next = errorModalQueueRef.current.shift();
    if (next) {
      errorModalOpenRef.current = true;
      setErrorModal({ ...next, open: true });
    }
  }
  
  const getErrorModalTitle = (kind: ErrorKind): string => {
    switch (kind) {
      case "expired":
        return "This ID has expired";
      case "invalid_id":
      case "invalid_file_type":
        return "Invalid ID";
      case "unable_to_process":
      case "file_too_large":
      case "resolution_issue":
      default:
        return "We weren't able to process this file";
    }
  };
  
  const getErrorModalMessage = (kind: ErrorKind, documentType?: string, expiryDate?: string, customReason?: string): string => {
    switch (kind) {
      case "expired":
        return `Your ${documentType || "ID"} expired on ${expiryDate || "an unknown date"}. Expired IDs cannot be used for identity verification.`;
      case "invalid_id":
        return customReason || "Health cards cannot be used for identity verification. Please upload a valid government-issued photo ID, such as a passport or driver's licence.";
      case "invalid_file_type":
        return "This file type is not supported. Please upload a PDF, JPG, PNG, or HEIC file.";
      case "file_too_large":
        return "This file is too large. Please upload a file smaller than 10 MB.";
      case "resolution_issue":
        return "ID details not readable. Please upload a clearer image or scan.";
      case "unable_to_process":
      default:
        return customReason || "We couldn't process this file. Please try again with a clearer image or smaller file size.";
    }
  };

  // Manual classification modal (when AI can't classify correctly)
  const [manualClassifyModal, setManualClassifyModal] = useState<{
    open: boolean;
    fileId: string;
    fileName: string;
    selectedType: string;
    selectedSide: ManualSide;
  }>({ open: false, fileId: "", fileName: "", selectedType: "", selectedSide: "front" });

  // Confirmation modal before submission
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Camera flow state (guided capture — number of steps depends on what's still needed)
  const webcamRef = useRef<Webcam | null>(null);
  const [cameraFlowOpen, setCameraFlowOpen] = useState(false);
  const [cameraStepIndex, setCameraStepIndex] = useState(0);
  const [cameraSteps, setCameraSteps] = useState<SlotKey[]>(ALL_CAMERA_STEPS);
  const [cameraCapturedFiles, setCameraCapturedFiles] = useState<Partial<Record<SlotKey, File>>>({});
  const [cameraCapturedPreview, setCameraCapturedPreview] = useState<Partial<Record<SlotKey, string>>>({});
  const [currentCapture, setCurrentCapture] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [sharpnessScore, setSharpnessScore] = useState<number | null>(null);
  const [sharpnessOk, setSharpnessOk] = useState(false);
  const [validatingImage, setValidatingImage] = useState(false);
  const [cameraSubmitting, setCameraSubmitting] = useState(false);
  const [retakingSlot, setRetakingSlot] = useState<SlotKey | null>(null);

  const resetAll = useCallback(() => {
    selected.forEach((s) => {
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
    });
    setSelected([]);
    setExisting([]);
    setGlobalError(null);
    setUploading(false);
    setSavingDraft(false);
    setDraftSaved(false);
    setDragOver(false);
    setCameraFlowOpen(false);
    setCameraStepIndex(0);
    setCameraCapturedFiles({});
    setCameraCapturedPreview({});
    setCurrentCapture(null);
    setCameraError(null);
    setSharpnessScore(null);
    setSharpnessOk(false);
    setValidatingImage(false);
    setCameraSubmitting(false);
    setRetakingSlot(null);
    setShowConfirmModal(false);
    errorModalQueueRef.current = [];
    errorModalOpenRef.current = false;
    setErrorModal({ open: false, fileId: "", fileName: "", kind: "invalid_id" });
  }, [selected]);

  const handleClose = useCallback(() => {
    resetAll();
    onClose();
  }, [onClose, resetAll]);

  // Load existing docs when drawer opens
  useEffect(() => {
    if (!open || !leadId) return;
    let cancelled = false;
    setLoadingExisting(true);
    fetch(`/api/admin/lead-identification-docs?lead_id=${encodeURIComponent(leadId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) setExisting(data.docs ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingExisting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, leadId]);

  // Close on Escape — skipped when embedded (the parent accordion owns Escape;
  // hijacking it here would close the whole multi-party modal).
  useEffect(() => {
    if (embedded) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) handleClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [open, handleClose, embedded]);

  // Lock body scroll — skipped when embedded (the parent accordion owns it).
  useEffect(() => {
    if (embedded) return;
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open, embedded]);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      selected.forEach((s) => {
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Manual upload handlers ──────────────────────────────────────────────────

  function nextDefaultLabel(currentSelected: SelectedFile[], existingDocs: ExistingDoc[]): LabelKey {
    const used = new Set<string>();
    for (const s of currentSelected) used.add(s.label);
    for (const d of existingDocs) if (d.custom_type) used.add(d.custom_type);
    for (const key of DEFAULT_ORDER) {
      if (!used.has(key)) return key;
    }
    return "other";
  }

  // Recompute duplicate flags for all files — duplicates are detected ONLY when
  // the exact same FILE is uploaded more than once (bit-for-bit identical
  // content, verified via SHA-256 hash). Two different files classified as the
  // same document type (e.g. two different passport scans, one per person) are
  // NEVER treated as duplicates.
  //
  // While a file's hash is still being computed, we conservatively skip the
  // check for that file — it'll be re-evaluated automatically once the hash is
  // available.
  function recomputeDuplicates(files: SelectedFile[]): SelectedFile[] {
    return files.map((file, index) => {
      let isDuplicate = false;
      let duplicateReason: string | null = null;

      if (file.contentHash) {
        for (let i = 0; i < index; i++) {
          const other = files[i];
          if (other.contentHash && other.contentHash === file.contentHash) {
            isDuplicate = true;
            duplicateReason = "This exact file has already been uploaded.";
            break;
          }
        }
      }

      return { ...file, isDuplicate, duplicateReason };
    });
  }

  // Compute a content hash for the given file, then re-run duplicate detection
  // across the current selection. Fire-and-forget from the caller.
  async function attachContentHash(id: string, file: File) {
    try {
      const hash = await computeFileContentHash(file);
      setSelected((prev) => {
        const updated = prev.map((s) =>
          s.id === id ? { ...s, contentHash: hash } : s,
        );
        return recomputeDuplicates(updated);
      });
    } catch {
      /* If hashing fails we leave contentHash null — the file simply won't be
         flagged as a duplicate, which is the safer default. */
    }
  }

  async function detectIdentification(id: string, file: File) {
    const result = await fetchDetection(file);
    const fileName = selectedRef.current.find((s) => s.id === id)?.file.name ?? "";

    if (!result.ok) {
      setSelected((prev) =>
        prev.map((s) =>
          s.id === id
            ? { ...s, detecting: false, detection: null, detectionError: result.error }
            : s,
        ),
      );
      const isResolutionIssue =
        result.error.toLowerCase().includes("blur") ||
        result.error.toLowerCase().includes("unclear") ||
        result.error.toLowerCase().includes("readable");

      openErrorModal({
        fileId: id,
        fileName,
        kind: isResolutionIssue ? "resolution_issue" : "unable_to_process",
        customReason: result.error,
      });
      return;
    }

    // Update this file's detection result first
    setSelected((prev) => {
      const updated = prev.map((s) =>
        s.id === id
          ? { ...s, detecting: false, detection: result.detection, detectionError: null }
          : s
      );
      
      // Now recompute duplicates for ALL files based on the new state
      return recomputeDuplicates(updated);
    });
    
    // Scroll to verification status section after detection completes
    setTimeout(() => {
      verificationStatusRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
    
    if (!result.detection.isIdentification) {
      openErrorModal({
        fileId: id,
        fileName,
        kind: "invalid_id",
        customReason: result.detection.reason?.trim() || undefined,
      });
    } else if (result.detection.expiryStatus === "expired") {
      openErrorModal({
        fileId: id,
        fileName,
        kind: "expired",
        documentType: result.detection.documentType ?? undefined,
        expiryDate: result.detection.expiryDate ?? undefined,
      });
    }
  }

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    const queuedForDetection: { id: string; file: File }[] = [];
    const additions: SelectedFile[] = [];
    const working = [...selected];

    for (const f of incoming) {
      const err = validateFile(f);
      if (err) {
        const isFileTooLarge = err.includes("10 MB") || err.toLowerCase().includes("size");
        openErrorModal({
          fileId: "",
          fileName: f.name,
          kind: isFileTooLarge ? "file_too_large" : "invalid_file_type",
        });
        continue;
      }
      
      const id = makeId();
      const nextItem: SelectedFile = {
        id,
        file: f,
        previewUrl: isImageFile(f) ? URL.createObjectURL(f) : null,
        error: null,
        label: nextDefaultLabel(working, existing),
        detecting: true,
        detection: null,
        detectionError: null,
        isDuplicate: false,
        duplicateReason: null,
        fromCamera: false,
        contentHash: null,
      };
      additions.push(nextItem);
      working.push(nextItem);
      queuedForDetection.push({ id, file: f });
    }

    if (additions.length > 0) {
      setSelected((prev) => recomputeDuplicates([...prev, ...additions]));
    }

    setGlobalError(null);

    // Kick off Gemini detection AND SHA-256 hashing for each newly added file
    // (fire-and-forget). Duplicate flags update automatically once each hash
    // resolves.
    queuedForDetection.forEach(({ id, file }) => {
      void detectIdentification(id, file);
      void attachContentHash(id, file);
    });
  }

  function removeSelected(id: string) {
    setSelected((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  }

  function openManualClassify(fileId: string, fileName: string) {
    errorModalQueueRef.current = [];
    closeErrorModal();
    
    // Pre-fill with existing detection if available
    const existingFile = selected.find((s) => s.id === fileId);
    const existingDetection = existingFile?.detection;
    
    setManualClassifyModal({
      open: true,
      fileId,
      fileName,
      selectedType: existingDetection?.isIdentification && existingDetection.documentType ? existingDetection.documentType : "",
      selectedSide: existingDetection?.side && existingDetection.side !== "unknown" ? existingDetection.side : "front",
    });
  }

  function applyManualClassification() {
    const { fileId, selectedType, selectedSide } = manualClassifyModal;
    if (!selectedType) return;

    const isSingleSided = SINGLE_SIDED_IDS.includes(selectedType);
    const sideRequirement = isSingleSided ? "single-sided" : "front-and-back";

    const manualDetection: DetectionResult = {
      isIdentification: true,
      documentType: selectedType,
      side: selectedSide,
      sideRequirement,
      confidence: "high",
      reason: "Manually classified by user",
      expiryDate: null,
      expiryStatus: "unknown",
    };

    setSelected((prev) => {
      const updated = prev.map((s) =>
        s.id === fileId
          ? { ...s, detection: manualDetection, detectionError: null, detecting: false }
          : s
      );
      return recomputeDuplicates(updated);
    });

    setManualClassifyModal({ open: false, fileId: "", fileName: "", selectedType: "", selectedSide: "front" });
  }

  async function removeExisting(id: string) {
    const prev = existing;
    setExisting((cur) => cur.filter((d) => d.id !== id));
    try {
      const res = await fetch(`/api/admin/lead-identification-docs?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? "Failed to delete");
    } catch (err: unknown) {
      setExisting(prev);
      setGlobalError(err instanceof Error ? err.message : "Failed to delete document.");
    }
  }

  function startReplace(id: string) {
    setReplacingId(id);
    setGlobalError(null);
    replaceInputRef.current?.click();
  }

  async function handleReplaceFile(file: File) {
    const id = replacingId;
    if (!id || !leadId) {
      setReplacingId(null);
      return;
    }

    const err = validateFile(file);
    if (err) {
      setGlobalError(`${file.name}: ${err}`);
      setReplacingId(null);
      return;
    }

    setReplacingId(id);
    try {
      const existingDoc = existing.find((d) => d.id === id);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("lead_id", leadId);
      fd.append("doc_type", DOC_TYPE);
      if (existingDoc?.custom_type) fd.append("custom_type", existingDoc.custom_type);
      const uploadRes = await fetch("/api/admin/uploadblobstorage", { method: "POST", body: fd });
      const uploadData = await uploadRes.json();
      if (!uploadData.success) throw new Error(uploadData.error ?? "Upload failed");

      const delRes = await fetch(`/api/admin/lead-identification-docs?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const delData = await delRes.json();
      if (!delData.success) throw new Error(delData.error ?? "Failed to remove old file");

      const r = await fetch(`/api/admin/lead-identification-docs?lead_id=${encodeURIComponent(leadId)}`);
      const d = await r.json();
      if (d.success) setExisting(d.docs ?? []);
    } catch (e: unknown) {
      setGlobalError(e instanceof Error ? e.message : "Failed to replace file.");
    } finally {
      setReplacingId(null);
    }
  }

  // ── Camera flow handlers ────────────────────────────────────────────────────

  const currentCameraSlot = cameraSteps[cameraStepIndex] ?? null;
  const cameraCapturedCount = Object.keys(cameraCapturedFiles).length;
  const cameraFlowReadyToSubmit =
    cameraSteps.length > 0 && cameraSteps.every((k) => !!cameraCapturedFiles[k]);

  // Count IDs already provided in this drawer so the camera only asks for what's left
  function countAlreadyProvidedIds(): number {
    // Count complete IDs in the current selection (front+back, both-sides, or single-sided)
    const selectedComplete = docAnalysis.filter((d) => d.complete).length;

    // Count distinct base types in previously uploaded docs as already-provided IDs
    const existingPrefixes = new Set<string>();
    for (const doc of existing) {
      if (!doc.custom_type) continue;
      const prefix = doc.custom_type
        .replace(/_front$|_back$|_front-and-back$/i, "")
        .toLowerCase()
        .trim();
      if (prefix) existingPrefixes.add(prefix);
    }

    return selectedComplete + existingPrefixes.size;
  }

  // Decide which camera slots to walk the user through based on what's still missing
  function computeCameraStepsNeeded(): SlotKey[] {
    const alreadyProvided = countAlreadyProvidedIds();
    if (alreadyProvided >= 2) return [];
    if (alreadyProvided === 1) return SECONDARY_CAMERA_STEPS;
    return ALL_CAMERA_STEPS;
  }

  function openCameraFlow() {
    const stepsNeeded = computeCameraStepsNeeded();
    setCameraSteps(stepsNeeded.length > 0 ? stepsNeeded : ALL_CAMERA_STEPS);
    setCameraFlowOpen(true);
    setCameraStepIndex(0);
    setCameraCapturedFiles({});
    setCameraCapturedPreview({});
    setCurrentCapture(null);
    setCameraError(null);
    setSharpnessScore(null);
    setSharpnessOk(false);
    setValidatingImage(false);
    setCameraSubmitting(false);
  }

  function closeCameraFlow() {
    setCameraFlowOpen(false);
    setCameraStepIndex(0);
    setCameraCapturedFiles({});
    setCameraCapturedPreview({});
    setCurrentCapture(null);
    setCameraError(null);
    setSharpnessScore(null);
    setSharpnessOk(false);
    setValidatingImage(false);
    setCameraSubmitting(false);
    setRetakingSlot(null);
  }

  async function handleCaptureImage() {
    const img = webcamRef.current?.getScreenshot();
    if (!img) {
      setCameraError("Could not capture image. Please allow camera access and try again.");
      return;
    }

    setCurrentCapture(img);
    setCameraError(null);
    setValidatingImage(true);

    try {
      const score = await computeImageSharpnessScore(img);
      const isSharp = score >= 2200;
      setSharpnessScore(score);
      setSharpnessOk(isSharp);
      if (!isSharp) {
        setCameraError("Image appears blurry. Please hold steady, improve lighting, and retake.");
      }
    } catch (err: unknown) {
      setCameraError(err instanceof Error ? err.message : "Unable to validate image quality.");
      setSharpnessScore(null);
      setSharpnessOk(false);
    } finally {
      setValidatingImage(false);
    }
  }

  async function handleUseCapturedImageForStep() {
    if (!currentCameraSlot || !currentCapture) return;
    if (!sharpnessOk) {
      setCameraError("Please retake a clearer image before using it.");
      return;
    }

    const file = await dataUrlToFile(currentCapture, `${currentCameraSlot}-${Date.now()}.jpg`);
    setCameraCapturedFiles((prev) => ({ ...prev, [currentCameraSlot]: file }));
    setCameraCapturedPreview((prev) => ({ ...prev, [currentCameraSlot]: currentCapture }));

    // If retaking a single slot, return to review screen
    if (retakingSlot) {
      setCameraStepIndex(cameraSteps.length);
      setCurrentCapture(null);
      setCameraError(null);
      setSharpnessScore(null);
      setSharpnessOk(false);
      setValidatingImage(false);
      setRetakingSlot(null);
      return;
    }

    if (cameraStepIndex < cameraSteps.length - 1) {
      setCameraStepIndex((prev) => prev + 1);
      setCurrentCapture(null);
      setCameraError(null);
      setSharpnessScore(null);
      setSharpnessOk(false);
      setValidatingImage(false);
      return;
    }

    setCameraStepIndex(cameraSteps.length);
    setCurrentCapture(null);
    setCameraError(null);
    setSharpnessScore(null);
    setSharpnessOk(false);
    setValidatingImage(false);
  }

  function openCameraStep(stepKey: SlotKey) {
    const nextIndex = cameraSteps.indexOf(stepKey);
    if (nextIndex < 0) return;
    setCameraStepIndex(nextIndex);
    setCurrentCapture(null);
    setCameraError(null);
    setSharpnessScore(null);
    setSharpnessOk(false);
    setValidatingImage(false);
    setRetakingSlot(null);
  }

  function retakeSingleSlot(stepKey: SlotKey) {
    const nextIndex = cameraSteps.indexOf(stepKey);
    if (nextIndex < 0) return;
    setCameraStepIndex(nextIndex);
    setCurrentCapture(null);
    setCameraError(null);
    setSharpnessScore(null);
    setSharpnessOk(false);
    setValidatingImage(false);
    setRetakingSlot(stepKey);
  }

  async function handleFinishCameraFlow() {
    if (!cameraFlowReadyToSubmit) {
      setCameraError(
        cameraSteps.length === ALL_CAMERA_STEPS.length
          ? "Please capture front and back for both IDs before finishing."
          : "Please capture front and back of the remaining ID before finishing.",
      );
      return;
    }

    // Convert camera captures to SelectedFile entries and add to selected state
    const newFiles: SelectedFile[] = [];
    const queuedForDetection: { id: string; file: File }[] = [];

    for (const slotKey of cameraSteps) {
      const file = cameraCapturedFiles[slotKey];
      const preview = cameraCapturedPreview[slotKey];
      if (!file) continue;

      const id = makeId();
      const newEntry: SelectedFile = {
        id,
        file,
        previewUrl: preview ?? null,
        error: null,
        label: SLOT_CUSTOM_TYPES[slotKey],
        detecting: true,
        detection: null,
        detectionError: null,
        isDuplicate: false,
        duplicateReason: null,
        fromCamera: true,
        contentHash: null,
      };
      newFiles.push(newEntry);
      queuedForDetection.push({ id, file });
    }

    if (newFiles.length > 0) {
      setSelected((prev) => recomputeDuplicates([...prev, ...newFiles]));
    }

    closeCameraFlow();

    // Run AI detection AND SHA-256 hashing on each captured image. Duplicate
    // flags will update automatically once each hash resolves.
    queuedForDetection.forEach(({ id, file }) => {
      void detectIdentification(id, file);
      void attachContentHash(id, file);
    });
  }

  // Add camera captures to selected files for review
  function handleFinishCameraFlowClick() {
    if (!cameraFlowReadyToSubmit) {
      setCameraError("Please capture front and back for both IDs before finishing.");
      return;
    }
    handleFinishCameraFlow();
  }

  // ── Manual upload submit ────────────────────────────────────────────────────

  async function handleUpload() {
    if (selected.length === 0) return;
    if (!leadId) {
      setGlobalError("Missing lead. Please refresh and try again.");
      return;
    }
    if (selected.length < 2) {
      setGlobalError("Please upload at least 2 identification documents.");
      return;
    }

    setUploading(true);
    setGlobalError(null);

    try {
      const uploads = selected.map(async (s) => {
        const fd = new FormData();
        fd.append("file", s.file);
        fd.append("lead_id", leadId);
        fd.append("doc_type", DOC_TYPE);
        // Use detected document type and side as custom_type
        const customType = s.detection?.documentType 
          ? `${s.detection.documentType}${s.detection.side !== "unknown" ? `_${s.detection.side}` : ""}`
          : "identification";
        fd.append("custom_type", customType);
        appendDetectionFields(fd, s.detection);
        const res = await fetch("/api/admin/uploadblobstorage", { method: "POST", body: fd });
        const data = await res.json();
        if (!data.success) throw new Error(`${s.file.name}: ${data.error ?? "Upload failed"}`);
        const url: string | undefined = data.url ?? data.file_url;
        if (!url) throw new Error(`${s.file.name}: upload did not return a URL.`);
        return { selected: s, url };
      });

      const uploaded = await Promise.all(uploads);

      if (taskId) {
        const respRes = await fetch("/api/admin/task-responses-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task_id: taskId,
            responses: uploaded.map(({ selected: s, url }) => ({
              field_label: s.detection?.documentType 
                ? `${s.detection.documentType}${s.detection.side !== "unknown" ? ` (${s.detection.side})` : ""}`
                : "Identification Document",
              field_type: "file",
              file_url: url,
              file_name: s.file.name,
            })),
          }),
        });
        if (!respRes.ok) throw new Error("Files uploaded, but failed to record task completion.");
        if (onSaved) onSaved();
      }

      // Clear selected and reload existing
      selected.forEach((s) => {
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      });
      setSelected([]);

      try {
        const r = await fetch(`/api/admin/lead-identification-docs?lead_id=${encodeURIComponent(leadId)}`);
        const d = await r.json();
        if (d.success) setExisting(d.docs ?? []);
      } catch {}
    } catch (err: unknown) {
      setGlobalError(err instanceof Error ? err.message : "One or more uploads failed.");
    } finally {
      setUploading(false);
    }
  }

  // Validate before showing confirmation modal
  function handleUploadClick() {
    if (selected.length === 0) return;
    if (!leadId) {
      setGlobalError("Missing lead. Please refresh and try again.");
      return;
    }
    if (selected.length < 2) {
      setGlobalError("Please upload at least 2 identification documents.");
      return;
    }
    setShowConfirmModal(true);
  }

  // Save current selection as a draft — uploads files to blob storage but does
  // NOT mark the task as completed. Skips files that are still being analyzed
  // or have failed detection (we don't want to persist known-invalid IDs).
  async function handleSaveDraft() {
    if (!leadId) {
      setGlobalError("Missing lead. Please refresh and try again.");
      return;
    }

    // Nothing in the picker → nothing to save. Just close gracefully.
    if (selected.length === 0) {
      handleClose();
      return;
    }

    const validToSave = selected.filter(
      (s) => !s.detecting && !s.isDuplicate,
    );

    if (validToSave.length === 0) {
      setGlobalError(
        "No saveable documents — please wait for analysis to finish or remove duplicate files.",
      );
      return;
    }

    setSavingDraft(true);
    setGlobalError(null);

    try {
      const uploads = validToSave.map(async (s) => {
        const fd = new FormData();
        fd.append("file", s.file);
        fd.append("lead_id", leadId);
        fd.append("doc_type", DOC_TYPE);
        const customType = s.detection?.documentType
          ? `${s.detection.documentType}${s.detection.side !== "unknown" ? `_${s.detection.side}` : ""}`
          : "identification";
        fd.append("custom_type", customType);
        appendDetectionFields(fd, s.detection);
        const res = await fetch("/api/admin/uploadblobstorage", {
          method: "POST",
          body: fd,
        });
        const data = await res.json();
        if (!data.success)
          throw new Error(`${s.file.name}: ${data.error ?? "Upload failed"}`);
      });

      await Promise.all(uploads);

      // Clear in-memory selection + refresh existing docs from DB so the user
      // sees their saved state immediately if they don't navigate away.
      selected.forEach((s) => {
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      });
      setSelected([]);

      try {
        const r = await fetch(
          `/api/admin/lead-identification-docs?lead_id=${encodeURIComponent(leadId)}`,
        );
        const d = await r.json();
        if (d.success) setExisting(d.docs ?? []);
      } catch {
        /* non-fatal — the docs are saved; reload just refreshes the UI */
      }

      setDraftSaved(true);
      setTimeout(() => handleClose(), 1500);
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error ? err.message : "Failed to save draft.",
      );
    } finally {
      setSavingDraft(false);
    }
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  // Group detected documents by type to determine if both sides are present
  // Now supports multiple documents detected in a single file
  const detectedDocs: { type: string; side: string; sideRequirement: string; isComplete: boolean; fileId: string }[] = [];
  for (const s of selected) {
    if (s.detection?.isIdentification) {
      // If multiple documents were detected in this file, add each one
      if (s.detection.multipleDocuments && s.detection.multipleDocuments.length > 0) {
        for (const doc of s.detection.multipleDocuments) {
          detectedDocs.push({
            type: doc.documentType,
            side: doc.side,
            sideRequirement: doc.sideRequirement,
            isComplete: doc.isComplete,
            fileId: s.id,
          });
        }
      } else if (s.detection.documentType) {
        // Single document detection (backward compatibility)
        const isComplete = 
          s.detection.sideRequirement === "single-sided" || 
          s.detection.side === "front-and-back";
        detectedDocs.push({
          type: s.detection.documentType,
          side: s.detection.side,
          sideRequirement: s.detection.sideRequirement,
          isComplete,
          fileId: s.id,
        });
      }
    }
  }

  // Group by document type
  const docTypeGroups = detectedDocs.reduce<Record<string, typeof detectedDocs>>((acc, doc) => {
    const key = doc.type;
    if (!acc[key]) acc[key] = [];
    acc[key].push(doc);
    return acc;
  }, {});

  // Analyze each document type for side coverage
  const docAnalysis: { type: string; hasFront: boolean; hasBack: boolean; hasBothSides: boolean; isSingleSided: boolean; complete: boolean }[] = [];
  for (const [type, docs] of Object.entries(docTypeGroups)) {
    const hasFront = docs.some(d => d.side === "front");
    const hasBack = docs.some(d => d.side === "back");
    const hasBothSides = docs.some(d => d.side === "front-and-back");
    const isSingleSided = docs.some(d => d.sideRequirement === "single-sided");
    // Use isComplete from detection if available, otherwise calculate
    const hasCompleteDoc = docs.some(d => d.isComplete);
    // For single-sided documents (passports), having either front or both makes it complete
    // This allows users to upload passport back as well without issues
    const complete = hasCompleteDoc || isSingleSided || hasBothSides || (hasFront && hasBack) || (isSingleSided && (hasFront || hasBack || hasBothSides));
    docAnalysis.push({ type, hasFront, hasBack, hasBothSides, isSingleSided, complete });
  }

  // Count complete documents (both sides or single-sided)
  const completeDocCount = docAnalysis.filter(d => d.complete).length;
  const incompleteDocCount = docAnalysis.filter(d => !d.complete).length;

  // Get complete single-sided document types (like passports) to be lenient with their backs
  const completeSingleSidedTypes = new Set(
    docAnalysis
      .filter(d => d.complete && d.isSingleSided)
      .map(d => d.type.toLowerCase())
  );
  
  // Check for detection failures, but be lenient with potential passport backs
  // If we have a complete passport and a file fails detection, it might just be the passport back
  // which is not required - don't block submission for this
  const hasDetectionFailures = selected.some((s) => {
    // Helper to check if this file is likely a passport back
    const isLikelyPassportBack = () => {
      const fileNameHasBack = s.file.name.toLowerCase().includes("back");
      const hasCompletePassport = completeSingleSidedTypes.has("canadian passport") || 
                                   completeSingleSidedTypes.has("foreign passport");
      const labelIndicatesBack = s.label.includes("back");
      
      return (fileNameHasBack && hasCompletePassport) || 
             (labelIndicatesBack && completeSingleSidedTypes.size > 0);
    };
    
    // Detection errors - be lenient for potential passport backs
    if (s.detectionError !== null) {
      if (isLikelyPassportBack()) {
        return false; // Don't block for passport back detection errors
      }
      return true;
    }
    
    // If detection succeeded but it's not identification
    if (s.detection !== null && !s.detection.isIdentification) {
      if (isLikelyPassportBack()) {
        return false; // Don't block for passport back rejection
      }
      return true;
    }
    
    return false;
  });

  // Check for expired or expiring-soon IDs
  const expiredDocs = selected.filter(
    s => s.detection?.isIdentification && s.detection.expiryStatus === "expired"
  );
  const expiringSoonDocs = selected.filter(
    s => s.detection?.isIdentification && s.detection.expiryStatus === "expiring_soon"
  );
  const hasExpiredDocs = expiredDocs.length > 0;
  const hasExpiringSoonDocs = expiringSoonDocs.length > 0;

  const hasPendingDetection = selected.some(s => s.detecting);

  // Allow upload as long as we have at least 2 files and analysis has finished.
  // Invalid / expired / incomplete IDs are surfaced as warnings but do not block
  // submission (e.g. the primary user uploading on behalf of their spouse).
  const canUpload =
    selected.length >= 2 &&
    !uploading &&
    !hasPendingDetection;

  return (
    <>
      {/* Backdrop — omitted when embedded (parent accordion owns chrome). */}
      {!embedded && (
        <div
          className={[
            "fixed inset-0 z-40 transition-opacity duration-300",
            isLargeScreen ? "bg-black/40 backdrop-blur-sm" : "bg-black/30",
            open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
          ].join(" ")}
          onClick={handleClose}
          aria-hidden="true"
        />
      )}

      {/* Modal (large screens) / Drawer (mobile) — or a plain flow container when embedded */}
      <div
        className={
          embedded
            ? "flex flex-col bg-white"
            : [
                "fixed z-50 bg-white shadow-2xl flex flex-col",
                isLargeScreen
                  ? "inset-4 sm:inset-8 md:inset-12 lg:inset-16 xl:inset-20 max-w-5xl max-h-[90vh] mx-auto my-auto rounded-2xl border border-gray-100"
                  : "top-0 right-0 h-full w-full max-w-[540px]",
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
              ].join(" ")
        }
        role={embedded ? undefined : "dialog"}
        aria-modal={embedded ? undefined : "true"}
        aria-label={embedded ? undefined : "Upload Identification Documents"}
      >
        {/* Header — omitted when embedded (the accordion section header stands in) */}
        {!embedded && (
          <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-gray-100">
            <div className="flex items-center gap-3 min-w-0 pr-4">
              <div className="w-9 h-9 rounded-full bg-[#FEF2F2] flex items-center justify-center text-[#C10007] flex-shrink-0">
                <IdCard size={17} strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-bold text-gray-900 leading-snug truncate">
                  Upload Identification Documents
                </h2>
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                  Upload your identification documents to verify your identity for the property transaction.
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
        )}

        {/* Body — scrollable modal region, or plain flow when embedded */}
        <div className={embedded ? "px-6 py-5 space-y-6" : "flex-1 overflow-y-auto px-6 py-5 space-y-6"}>
          {/* "Uploading for" person selector — only rendered when the primary
              opens the drawer and there's more than one family member to
              choose from. Switching selection bubbles up to the parent which
              remounts the drawer so internal upload state resets cleanly. */}
          {personOptions && personOptions.length > 1 && onPersonChange && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/40 px-4 py-3">
              <label
                htmlFor="upload-id-person-selector"
                className="block text-xs font-bold text-slate-700 mb-1.5"
              >
                Uploading identification for
              </label>
              <select
                id="upload-id-person-selector"
                value={leadId ?? ""}
                onChange={(e) => {
                  const opt = personOptions.find(
                    (p) => p.leadId === e.target.value,
                  );
                  if (opt) onPersonChange(opt.leadId, opt.taskId);
                }}
                className="w-full px-3 py-2 text-sm font-semibold text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
              >
                {personOptions.map((p) => (
                  <option key={p.leadId} value={p.leadId}>
                    {p.name} — {p.role}
                    {p.completed ? " (already completed)" : ""}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 mt-1.5">
                Switching changes who these documents are attached to.
              </p>
            </div>
          )}

          {/* Acceptable Documents Section - Always visible */}
          <AcceptableDocumentsSection />

          {/* Why is Identification Required - Collapsible */}
          <WhyIdentificationRequiredDropdown />

          {/* Take Photos with Camera Option */}
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-[#FEF2F2] flex items-center justify-center flex-shrink-0">
                <Camera size={18} className="text-[#C10007]" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">Have a camera?</p>
                <p className="text-xs text-gray-500">
                  {hasPendingDetection
                    ? "Analyzing your uploaded files… camera will be available once that's done."
                    : "Capture each ID with your camera — no need to save the photo first."}
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={openCameraFlow}
              disabled={uploading || hasPendingDetection}
              className="flex-shrink-0"
            >
              <span className="inline-flex items-center gap-1.5">
                {hasPendingDetection ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Camera size={14} />
                )}
                {hasPendingDetection ? "Analyzing..." : "Use Camera"}
              </span>
            </Button>
          </div>

          {/* Manual Upload zone */}
          <div>
            <h3 className="text-sm font-bold text-gray-900 mb-2">Add Documents</h3>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
              className={[
                "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-all select-none",
                dragOver
                  ? "border-[#C10007] bg-[#FEF2F2]"
                  : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
              ].join(" ")}
            >
              <div
                className={[
                  "w-12 h-12 rounded-full flex items-center justify-center transition-colors",
                  dragOver ? "bg-[#FEF2F2]" : "bg-gray-100",
                ].join(" ")}
              >
                <Upload size={20} className={dragOver ? "text-[#C10007]" : "text-gray-400"} strokeWidth={2} />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-700">
                  Click to select or drag files here
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Select multiple files at once • PDF, JPG, PNG, HEIC • Max 10MB each
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.heic"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          {/* Existing uploaded docs */}
          {loadingExisting && (
            <p className="text-xs text-gray-400">Loading previously uploaded documents...</p>
          )}
          {existing.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-gray-900 mb-2">
                Previously Uploaded ({existing.length})
              </h3>
              <ul className="space-y-2">
                {existing.map((doc) => {
                  const isReplacing = replacingId === doc.id;
                  return (
                    <li
                      key={doc.id}
                      className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2"
                    >
                      <CheckCircle2 size={16} className="text-green-600 flex-shrink-0" strokeWidth={2.5} />
                      <div className="min-w-0 flex-1">
                        {doc.file_url ? (
                          <a
                            href={doc.file_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-semibold text-green-800 hover:underline truncate block"
                          >
                            {doc.file_name ?? "Document"}
                          </a>
                        ) : (
                          <p className="text-xs font-semibold text-green-800 truncate">
                            {doc.file_name ?? "Document"}
                          </p>
                        )}
                        {doc.custom_type && (
                          <p className="text-[10px] font-medium text-green-700 mt-0.5">
                            {labelText(doc.custom_type as LabelKey)}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => startReplace(doc.id)}
                        disabled={isReplacing || !!replacingId}
                        className="cursor-pointer flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-gray-700 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed"
                        aria-label="Replace"
                      >
                        <RefreshCw size={12} className={isReplacing ? "animate-spin" : ""} />
                        {isReplacing ? "Replacing..." : "Replace"}
                      </button>
                      <button
                        onClick={() => removeExisting(doc.id)}
                        disabled={!!replacingId}
                        className="cursor-pointer flex-shrink-0 p-1.5 rounded-md text-gray-500 hover:text-[#C10007] hover:bg-red-50 disabled:opacity-60 disabled:cursor-not-allowed"
                        aria-label="Remove"
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <input
                ref={replaceInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.heic"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleReplaceFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          )}

          {/* Selected (pending) files */}
          {selected.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-gray-900 mb-2">
                Uploaded Files ({selected.length})
              </h3>
              <ul className="space-y-2">
                {selected.map((s) => {
                  const hasError =
                    !!s.detectionError ||
                    (s.detection && !s.detection.isIdentification) ||
                    s.detection?.expiryStatus === "expired" ||
                    s.detection?.expiryStatus === "expiring_soon" ||
                    s.isDuplicate;
                  const isDetected = s.detection?.isIdentification && s.detection.documentType;
                  const showDuplicate = s.isDuplicate;
                  return (
                    <li
                      key={s.id}
                      className={[
                        "rounded-lg border bg-white",
                        hasError
                          ? "border-red-300"
                          : isDetected
                            ? "border-green-200"
                            : "border-gray-200",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {s.detecting ? (
                            <Loader2 size={14} className="animate-spin text-gray-400 flex-shrink-0" />
                          ) : hasError ? (
                            <AlertCircle size={14} className="text-[#C10007] flex-shrink-0" />
                          ) : s.detection?.isIdentification ? (
                            <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                          ) : (
                            <AlertCircle size={14} className="text-gray-400 flex-shrink-0" />
                          )}
                          <div className="w-10 h-10 rounded-md overflow-hidden bg-gray-100 flex items-center justify-center">
                            {s.previewUrl ? (
                              <NextImage
                                src={s.previewUrl}
                                alt={s.file.name}
                                width={40}
                                height={40}
                                unoptimized
                                className="object-cover w-full h-full"
                              />
                            ) : (
                              <FileText size={16} className="text-gray-400" />
                            )}
                          </div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-gray-800 truncate">{s.file.name}</p>
                          {isDetected ? (
                            <div className="flex flex-col gap-0.5 mt-0.5">
                              <p className={`text-[11px] font-medium truncate ${hasError ? "text-[#C10007]" : "text-green-600"}`}>
                                {s.detection!.documentType}
                                {s.detection!.sideRequirement === "single-sided"
                                  ? ""
                                  : s.detection!.side === "front-and-back"
                                    ? " · both sides in one image"
                                    : s.detection!.side !== "unknown"
                                      ? ` (${s.detection!.side})`
                                      : ""}
                              </p>
                              {showDuplicate && (
                                <div className="flex items-center gap-1 text-[10px] text-[#C10007] font-medium" title={s.duplicateReason ?? undefined}>
                                  <AlertCircle size={10} />
                                  <span>Duplicate file</span>
                                </div>
                              )}
                              {s.detection!.expiryStatus === "expired" && (
                                <div className="flex items-center gap-1 text-[10px] text-[#C10007] font-medium">
                                  <Clock size={10} />
                                  <span>Expired{s.detection!.expiryDate && ` (${s.detection!.expiryDate})`}</span>
                                </div>
                              )}
                              {s.detection!.expiryStatus === "expiring_soon" && (
                                <div className="flex items-center gap-1 text-[10px] text-[#C10007] font-medium">
                                  <Clock size={10} />
                                  <span>Expiring soon{s.detection!.expiryDate && ` (${s.detection!.expiryDate})`}</span>
                                </div>
                              )}
                            </div>
                          ) : s.detectionError ? (
                            <div className="flex flex-col gap-0.5 mt-0.5">
                              <p className="text-[11px] font-medium text-[#C10007]">Unable to process</p>
                              {showDuplicate && (
                                <div className="flex items-center gap-1 text-[10px] text-[#C10007] font-medium" title={s.duplicateReason ?? undefined}>
                                  <AlertCircle size={10} />
                                  <span>Duplicate file</span>
                                </div>
                              )}
                            </div>
                          ) : s.detection && !s.detection.isIdentification ? (
                            <div className="flex flex-col gap-0.5 mt-0.5">
                              <p className="text-[11px] font-medium text-[#C10007]">Invalid ID</p>
                              {showDuplicate && (
                                <div className="flex items-center gap-1 text-[10px] text-[#C10007] font-medium" title={s.duplicateReason ?? undefined}>
                                  <AlertCircle size={10} />
                                  <span>Duplicate file</span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-col gap-0.5 mt-0.5">
                              <p className="text-[11px] text-gray-400">{formatBytes(s.file.size)}</p>
                              {showDuplicate && (
                                <div className="flex items-center gap-1 text-[10px] text-[#C10007] font-medium" title={s.duplicateReason ?? undefined}>
                                  <AlertCircle size={10} />
                                  <span>Duplicate file</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {/* Reclassify button - opens modal */}
                        <button
                          onClick={() => openManualClassify(s.id, s.file.name)}
                          className="cursor-pointer flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-gray-600 bg-gray-50 border border-gray-200 hover:border-gray-300 hover:bg-gray-100 transition-colors"
                          aria-label="Reclassify document"
                        >
                          Reclassify
                        </button>
                        <button
                          onClick={() => removeSelected(s.id)}
                          className="cursor-pointer flex-shrink-0 p-1.5 rounded-md text-gray-400 hover:text-[#C10007] hover:bg-red-50"
                          aria-label="Remove"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <button
                onClick={() => fileInputRef.current?.click()}
                className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#C10007] hover:underline cursor-pointer"
              >
                <Plus size={12} />
                Add more files
              </button>
            </div>
          )}

          {/* Unified Verification Status Section */}
          {selected.length > 0 && !hasPendingDetection && (
            <div
              ref={verificationStatusRef}
              className={[
                "rounded-xl border overflow-hidden bg-white",
                completeDocCount >= 2
                  ? "border-green-200"
                  : "border-red-300 border-t-4 border-t-[#C10007]",
              ].join(" ")}
            >
              {/* Status Header */}
              <div className={[
                "px-4 py-3 flex items-center gap-3",
                completeDocCount >= 2 ? "bg-green-50 border-b border-green-100" : "bg-white",
              ].join(" ")}>
                {completeDocCount >= 2 ? (
                  <>
                    <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                      <CheckCircle2 size={18} className="text-white" strokeWidth={2.5} />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-green-800">Ready to Submit</p>
                      <p className="text-xs text-green-700">
                        {completeDocCount} government IDs verified
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="w-8 h-8 rounded-full bg-[#C10007] flex items-center justify-center flex-shrink-0">
                      <AlertCircle size={18} className="text-white" strokeWidth={2.5} />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900">
                        {completeDocCount === 0
                          ? "2 Government IDs Recommended"
                          : "1 More Government ID Recommended"}
                      </p>
                      <p className="text-xs text-gray-900">
                        {completeDocCount}/2 verified
                        {incompleteDocCount > 0 && " — see details below"}
                      </p>
                    </div>
                  </>
                )}
              </div>

              {/* Document Details — always white background below header */}
              {docAnalysis.length > 0 && (
                <div className="px-4 py-3 bg-white border-t border-gray-100 space-y-2">
                  {docAnalysis.map((doc, idx) => (
                    <div key={idx} className="flex items-start gap-2.5 text-xs">
                      {doc.complete ? (
                        <CheckCircle2 size={14} className="text-green-600 flex-shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle size={14} className="text-[#C10007] flex-shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1 text-gray-900">
                        <span className="font-semibold">{doc.type}</span>
                        <span>
                          {doc.complete
                            ? doc.isSingleSided
                              ? " — verified"
                              : doc.hasBothSides
                                ? " — front & back in one image"
                                : " — both sides verified"
                            : ` — missing ${!doc.hasFront && !doc.hasBack ? "front & back" : !doc.hasFront ? "front" : "back"}`
                          }
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Action hint for incomplete state */}
              {completeDocCount < 2 && (
                <div className="px-4 py-2.5 bg-white border-t border-gray-100">
                  <p className="text-xs text-gray-900">
                    {incompleteDocCount > 0 && completeDocCount < 2
                      ? "You can still submit — upload the missing side or a different ID for best results."
                      : completeDocCount === 0
                        ? "You can still submit — for best results upload front and back of each ID, or single-sided IDs like a passport."
                        : "You can still submit — upload one more government ID to complete verification."
                    }
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Detection errors callout */}
          {selected.length > 0 && !hasPendingDetection && hasDetectionFailures && (
            <div className="flex items-start gap-2 text-xs text-[#C10007] bg-[#FEF2F2] border border-red-200 rounded-lg px-3 py-2.5">
              <AlertCircle size={13} strokeWidth={2} className="flex-shrink-0 mt-0.5 text-[#C10007]" />
              <span>
                Some files couldn&rsquo;t be identified as valid government IDs. You can still submit, but please double-check these documents.
              </span>
            </div>
          )}

          {/* Expiring soon warning */}
          {selected.length > 0 && !hasPendingDetection && !hasExpiredDocs && hasExpiringSoonDocs && (
            <div className="flex items-start gap-2 text-xs text-[#C10007] bg-[#FEF2F2] border border-red-200 rounded-lg px-3 py-2.5">
              <Clock size={13} strokeWidth={2} className="flex-shrink-0 mt-0.5 text-[#C10007]" />
              <div>
                <span className="font-semibold">ID expiring soon.</span>{" "}
                <span>
                  {expiringSoonDocs.length === 1
                    ? `Your ${expiringSoonDocs[0].detection?.documentType} will expire within 30 days. Consider using a different ID if your closing is after that date.`
                    : `${expiringSoonDocs.length} of your IDs will expire within 30 days. Consider using different IDs if your closing is after those dates.`}
                </span>
              </div>
            </div>
          )}

          {/* Global error */}
          {globalError && (
            <div className="flex items-start gap-2 text-xs text-[#C10007] bg-[#FEF2F2] border border-red-200 rounded-lg px-3 py-2.5">
              <AlertCircle size={13} strokeWidth={2} className="flex-shrink-0 mt-0.5" />
              <span>{globalError}</span>
            </div>
          )}

          {/* Draft saved success indicator */}
          {draftSaved && (
            <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5">
              <CheckCircle2 size={14} strokeWidth={2.5} className="flex-shrink-0" />
              <span className="font-semibold">Draft saved! You can come back later to finish.</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex flex-col-reverse sm:flex-row gap-3">
          <Button
            variant="secondary"
            fullWidth
            onClick={handleSaveDraft}
            disabled={uploading || hasPendingDetection}
            loading={savingDraft}
            className="sm:flex-1"
          >
            Save as Draft
          </Button>
          <Button
            variant="primary"
            fullWidth
            disabled={selected.length === 0 || hasPendingDetection || savingDraft}
            loading={uploading}
            onClick={() => {
              if (canUpload) {
                handleUploadClick();
              } else {
                verificationStatusRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            }}
            className="sm:flex-1"
          >
            {selected.length === 0
              ? "Upload Documents"
              : hasPendingDetection
                ? "Analyzing..."
                : selected.length < 2
                  ? "Add at Least 2 Documents"
                  : `Upload ${selected.length} Document${selected.length > 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>

      {/* Simplified error modal */}
      {errorModal.open && (
        <>
          <div
            className="fixed inset-0 z-[80] bg-black/40"
            aria-hidden="true"
          />
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center px-5"
            role="dialog"
            aria-modal="true"
            aria-label="File upload error"
          >
            <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
              {/* Icon */}
              <div className="flex justify-center pt-8 pb-4">
                <div className="w-14 h-14 rounded-full bg-[#FEF2F2] flex items-center justify-center">
                  <AlertCircle size={28} className="text-[#C10007]" strokeWidth={1.75} />
                </div>
              </div>

              {/* Title and reason */}
              <div className="px-6 pb-6 text-center space-y-3">
                <h3 className="text-base font-bold text-gray-900">
                  {getErrorModalTitle(errorModal.kind)}
                </h3>
                <p className="text-sm text-gray-600 leading-relaxed">
                  {getErrorModalMessage(
                    errorModal.kind,
                    errorModal.documentType,
                    errorModal.expiryDate,
                    errorModal.customReason
                  )}
                </p>
              </div>

              {/* Single OK button */}
              <div className="px-6 pb-6">
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={closeErrorModal}
                >
                  OK
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Manual classification modal */}
      {manualClassifyModal.open && (
        <>
          <div
            className="fixed inset-0 z-[80] bg-black/40"
            aria-hidden="true"
          />
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center px-5"
            role="dialog"
            aria-modal="true"
            aria-label="Manually classify document"
          >
            <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
              {/* Header */}
              <div className="px-6 pt-6 pb-4 relative">
                <button
                  onClick={() =>
                    setManualClassifyModal({ open: false, fileId: "", fileName: "", selectedType: "", selectedSide: "front" })
                  }
                  className="absolute top-4 right-4 cursor-pointer rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
                <div className="flex items-center gap-3 mb-3 pr-8">
                  <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center">
                    <FileText size={20} className="text-blue-600" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-gray-900">Classify Document</h3>
                    <p className="text-xs text-gray-500 truncate max-w-[200px]">
                      {manualClassifyModal.fileName}
                    </p>
                  </div>
                </div>
                <p className="text-sm text-gray-600 leading-relaxed">
                  Select the document type and which side is shown in this image.
                </p>
              </div>

              {/* Form */}
              <div className="px-6 pb-4 space-y-4">
                {/* Document Type */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                    Document Type <span className="text-[#C10007]">*</span>
                  </label>
                  <select
                    value={manualClassifyModal.selectedType}
                    onChange={(e) =>
                      setManualClassifyModal((prev) => ({
                        ...prev,
                        selectedType: e.target.value,
                        selectedSide: SINGLE_SIDED_IDS.includes(e.target.value) ? "front" : prev.selectedSide,
                      }))
                    }
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#C10007]/20 focus:border-[#C10007] cursor-pointer"
                  >
                    <option value="">Select document type...</option>
                    {ACCEPTABLE_ID_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Side Selection - only show for front-and-back required docs */}
                {manualClassifyModal.selectedType && !SINGLE_SIDED_IDS.includes(manualClassifyModal.selectedType) && (
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                      Side Shown <span className="text-[#C10007]">*</span>
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {(["front", "back", "front-and-back"] as ManualSide[]).map((side) => (
                        <button
                          key={side}
                          type="button"
                          onClick={() =>
                            setManualClassifyModal((prev) => ({ ...prev, selectedSide: side }))
                          }
                          className={[
                            "px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer",
                            manualClassifyModal.selectedSide === side
                              ? "border-[#C10007] bg-[#FEF2F2] text-[#C10007]"
                              : "border-gray-200 bg-white text-gray-700 hover:border-gray-300",
                          ].join(" ")}
                        >
                          {side === "front-and-back" ? "Both Sides" : side.charAt(0).toUpperCase() + side.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Info for single-sided docs */}
                {manualClassifyModal.selectedType && SINGLE_SIDED_IDS.includes(manualClassifyModal.selectedType) && (
                  <div className="flex items-start gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5">
                    <ShieldCheck size={14} className="flex-shrink-0 mt-0.5" />
                    <span>Passports only require the photo/info page — no back side needed.</span>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="px-6 pb-6">
                <Button
                  variant="primary"
                  fullWidth
                  disabled={!manualClassifyModal.selectedType}
                  onClick={applyManualClassification}
                >
                  Update
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Confirmation modal before submission */}
      {showConfirmModal && (
        <>
          <div
            className="fixed inset-0 z-[100] bg-black/40"
            onClick={() => !uploading && !cameraSubmitting && setShowConfirmModal(false)}
            aria-hidden="true"
          />
          <div
            className="fixed inset-0 z-[110] flex items-center justify-center px-5"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm submission"
          >
            <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
              {/* Warning banner */}
              <div className="bg-[#FEF2F2] border-b border-red-200 px-5 py-4">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5">
                    <AlertCircle size={20} className="text-[#C10007]" strokeWidth={2} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-[#C10007]">
                      ID cannot be changed after submission.
                    </p>
                    <p className="text-sm text-[#C10007]/90 mt-1 leading-relaxed">
                      Please ensure it is accurate before submitting — otherwise you&apos;ll have to contact a law clerk to change the info.
                    </p>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="px-5 py-4 flex flex-col gap-2.5">
                <Button
                  variant="primary"
                  fullWidth
                  loading={uploading}
                  onClick={() => {
                    setShowConfirmModal(false);
                    handleUpload();
                  }}
                >
                  Confirm Submission
                </Button>
                <Button
                  variant="secondary"
                  fullWidth
                  disabled={uploading}
                  onClick={() => setShowConfirmModal(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Camera flow overlay (guided 4-step) */}
      {cameraFlowOpen && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/55"
            onClick={closeCameraFlow}
            aria-hidden="true"
          />
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center px-4"
            role="dialog"
            aria-modal="true"
            aria-label="Capture ID with camera"
          >
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-gray-100">
              <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100">
                <div className="pr-4">
                  <h3 className="text-sm font-bold text-gray-900">Use Camera - Guided Capture</h3>
                  {cameraStepIndex < cameraSteps.length ? (
                    <p className="text-xs text-gray-500 mt-1">
                      Step {cameraStepIndex + 1} of {cameraSteps.length}:{" "}
                      {SLOT_LABELS[currentCameraSlot as SlotKey]}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 mt-1">
                      {cameraSteps.length === ALL_CAMERA_STEPS.length
                        ? "Review all captured images, then click Finish."
                        : "Review your captured image, then click Finish."}
                    </p>
                  )}
                </div>
                <button
                  onClick={closeCameraFlow}
                  className="cursor-pointer rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                  aria-label="Close camera"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="px-5 py-4 space-y-3">
                {cameraStepIndex < cameraSteps.length ? (
                  !currentCapture ? (
                    <>
                      <div className="relative mx-auto w-full max-w-sm aspect-square overflow-hidden rounded-xl bg-gray-950">
                        <Webcam
                          ref={webcamRef}
                          audio={false}
                          screenshotFormat="image/jpeg"
                          screenshotQuality={0.95}
                          videoConstraints={{ facingMode: "environment" }}
                          onUserMediaError={() =>
                            setCameraError("Unable to access camera. Please allow camera permissions.")
                          }
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                        <div className="pointer-events-none absolute inset-3 rounded-xl border-2 border-dashed border-white/85" />
                        <div className="pointer-events-none absolute inset-0 ring-1 ring-black/10" />
                      </div>
                      <p className="text-[11px] text-gray-500 text-center">
                        Center the full ID in the square, avoid glare, and hold still before capture.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="relative mx-auto w-full max-w-sm aspect-square overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
                        <NextImage
                          src={currentCapture}
                          alt="Captured ID preview"
                          fill
                          unoptimized
                          className="object-cover"
                        />
                      </div>
                      <div className="text-center">
                        <p className="text-xs font-semibold text-gray-700">
                          Review {SLOT_LABELS[currentCameraSlot as SlotKey]}
                        </p>
                        <p className="text-[11px] text-gray-500 mt-1">
                          Ensure text is readable and all corners of the ID are visible.
                        </p>
                        {sharpnessScore !== null && sharpnessOk && (
                          <p className="text-[11px] mt-2 text-green-600">
                            Image looks good!
                          </p>
                        )}
                      </div>
                    </>
                  )
                ) : (
                  <div className="space-y-3">
                    <div className={`grid gap-2 sm:gap-3 ${cameraSteps.length <= 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
                      {cameraSteps.map((key) => (
                        <div key={key} className="rounded-xl border border-gray-200 bg-gray-50 p-2 sm:p-2.5">
                          <p className="text-[10px] sm:text-xs font-semibold text-gray-700 mb-1.5 truncate">{SLOT_LABELS[key]}</p>
                          {cameraCapturedPreview[key] ? (
                            <div className="relative aspect-[3/4] overflow-hidden rounded-lg border border-gray-200">
                              <NextImage
                                src={cameraCapturedPreview[key] as string}
                                alt={`${SLOT_LABELS[key]} preview`}
                                fill
                                unoptimized
                                className="object-cover"
                              />
                            </div>
                          ) : (
                            <div className="aspect-[3/4] rounded-lg border border-dashed border-gray-300 bg-white flex items-center justify-center text-[10px] sm:text-xs text-gray-400 text-center px-1">
                              Not captured
                            </div>
                          )}
                          <button
                            onClick={() => retakeSingleSlot(key)}
                            className="mt-1.5 cursor-pointer text-[10px] sm:text-xs font-semibold text-[#C10007] hover:underline"
                          >
                            Retake
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
                      Captured {cameraCapturedCount} of {cameraSteps.length} required photos.
                    </div>
                  </div>
                )}

                {cameraError && (
                  <div className="flex items-start gap-2 text-xs text-[#C10007] bg-[#FEF2F2] border border-red-200 rounded-lg px-3 py-2.5">
                    <AlertCircle size={13} strokeWidth={2} className="flex-shrink-0 mt-0.5" />
                    <span>{cameraError}</span>
                  </div>
                )}
              </div>

              <div className="px-5 py-4 border-t border-gray-100 flex flex-wrap gap-2">
                {cameraStepIndex < cameraSteps.length ? (
                  !currentCapture ? (
                    <Button
                      variant="primary"
                      fullWidth
                      onClick={handleCaptureImage}
                      className="sm:flex-1"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Camera size={14} />
                        Capture {SLOT_LABELS[currentCameraSlot as SlotKey]}
                      </span>
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        fullWidth
                        onClick={() => {
                          setCurrentCapture(null);
                          setCameraError(null);
                          setSharpnessScore(null);
                          setSharpnessOk(false);
                        }}
                        className="sm:flex-1"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <RotateCcw size={14} />
                          Retake
                        </span>
                      </Button>
                      <Button
                        variant="primary"
                        fullWidth
                        disabled={!sharpnessOk || validatingImage}
                        onClick={handleUseCapturedImageForStep}
                        className="sm:flex-1"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {cameraStepIndex < cameraSteps.length - 1
                            ? "Use & Next Step"
                            : cameraSteps.length === 1
                              ? "Use & Review"
                              : "Use & Review All"}
                          <ArrowRight size={14} />
                        </span>
                      </Button>
                    </>
                  )
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      fullWidth
                      onClick={() => openCameraStep(cameraSteps[0])}
                      className="sm:flex-1"
                    >
                      Capture Again
                    </Button>
                    <Button
                      variant="primary"
                      fullWidth
                      disabled={!cameraFlowReadyToSubmit}
                      onClick={handleFinishCameraFlowClick}
                      className="sm:flex-1"
                    >
                      Add to Review
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
