"use client";

import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { formatPostalCode } from "@/lib/addressFields";
import { docDownloadHref, docFetchCredentials } from "@/lib/blobPrivacy";
import { openDocForViewing } from "@/lib/docViewer";
import {
  FIRMS,
  FIRM_KEYS,
  resolveFirmKey,
  type FirmKey,
} from "@/lib/firms";
import {
  History,
  Mail,
  Key,
  User as UserIcon,
  Building2,
  ExternalLink,
  Send,
  ChevronDown,
  ShieldCheck,
  Smartphone,
  Fingerprint,
  CheckCircle2,
  Printer,
  Plus,
  ArrowLeft,
  X,
  Search,
  ArrowRight,
  MapPin,
  FileText,
  Briefcase as BriefcaseIcon,
  Loader2,
  AlertTriangle,
  CalendarDays,
  Zap,
  Users,
  UserPlus,
  Link2,
  Trash2,
  Edit3,
  Save,
  Eye,
  Download,
  Paperclip,
} from "lucide-react";

// A row from the `partners` master — the referral agent/broker on a file.
interface ReferralPartner {
  id: string;
  agent_name: string | null;
  agent_email: string | null;
  agent_phone: string | null;
  brokerage_type: string | null;
  brokerage_name: string | null;
  referral_code: string | null;
}

// One agreement on the file, as /api/admin/leads/[id]/aps-documents returns it.
// Already filtered to the APS, family-wide, deduped by blob URL and ordered
// purchase-side first — see leadApsDocuments.ts. Declared locally rather than
// imported so the server-only module behind that route stays out of this bundle.
interface ApsDocRow {
  /** Whose upload it was; "" when the source row has no lead. */
  leadId: string;
  fileUrl: string;
  fileName: string;
  /** "Purchase" / "Sale", or "" when the agreement is not side-specific. */
  label: string;
}

interface LeadUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  isCorporate: boolean;
  corporateName?: string;
  incNumber?: string;
  addressStreet?: string;
  addressUnit?: string;
  addressCity?: string;
  addressPostalCode?: string;
  addressProvince?: string;
  propertyType?: string;
  ownershipHistory?: string;
  maritalStatus?: string;
  citizenshipStatus?: string;
  occupation?: string;
  employerPhone?: string;
  status?: string;
  lead_type?: string;
  // Transaction amounts captured at intake. `price` is the PURCHASE price
  // (text column on leads); `sellingPrice` is the SALE price (numeric column),
  // only populated on combined Purchase & Sale files. The deposits are the
  // amounts already paid on each side (both numeric columns) — blank means the
  // client didn't give one, which is NOT the same as zero.
  price?: string;
  sellingPrice?: string;
  depositAmount?: string;
  sellingDepositAmount?: string;
  // Closing (completion) date given at intake — typed on the customer form's
  // Price & Address step, or read off the APS the client uploaded. Optional:
  // blank means they didn't know it yet, which is normal before signing.
  // `sellingClosingDate` is the sale-side date on Purchase & Sale files.
  // Both are ISO "YYYY-MM-DD".
  closingDate?: string;
  sellingClosingDate?: string;
  created_at?: string;
  service?: string;
  subService?: string;
  apsSigned?: boolean;
  referralSource?: string;
  sellingAddressStreet?: string;
  sellingAddressUnit?: string;
  sellingAddressCity?: string;
  sellingAddressPostalCode?: string;
  sellingAddressProvince?: string;
  parentLeadId?: string | null;
  // Authoritative co-* role recorded when the co-lead was added at intake
  // ("purchaser" / "seller"). When present this overrides the address-
  // matching heuristic in getCoRole(), which can't distinguish roles on
  // Purchase & Sale parents where both co-leads share both addresses.
  coPersonRole?: "purchaser" | "seller" | null;
  // Referral attribution — set from the code applied at intake, or linked
  // afterwards from the Partner Details section.
  referralPartner?: ReferralPartner | null;
  // Manual "no code" referral captured at intake. Read-only legacy: linking an
  // agent from the admin UI clears these in favour of referralPartner.
  referralAgentName?: string | null;
  referralAgentCompany?: string | null;
  referralAgentEmail?: string | null;
  // Whether the agent has had the one-off "your client signed up" email. Drives
  // the manual Notify Agent catch-up for agents linked after activation.
  agentSignupEmailSent?: boolean;
  // Which firm the FILE is retained under — "navawilson" | "iclosed".
  // Undefined on a row read before the firm_key migration; resolveFirmKey()
  // treats that as Nava Wilson, which is what every file already was.
  firmKey?: string;
}

const Leads: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The lead detail view is in-page state, but we mirror it in the URL as
  // ?lead=<id> so navigation stays in sync. Clicking "Leads" in the sidebar
  // links to /admin/leads (no param); Next.js keeps this component mounted on a
  // same-route click, so without a URL-driven reset the detail view would stay
  // stuck open. The effect below snaps back to the list whenever the param goes.
  const leadParam = searchParams.get("lead");
  const [view, setView] = useState<"LIST" | "DETAIL">("LIST");
  const [selectedLead, setSelectedLead] = useState<LeadUser | null>(null);

  useEffect(() => {
    if (!leadParam) {
      setView("LIST");
      setSelectedLead(null);
    }
  }, [leadParam]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newClientType, setNewClientType] = useState<
    "residential" | "corporate"
  >("residential");
  const [search, setSearch] = useState("");

  const [leads, setLeads] = useState<LeadUser[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadsError, setLeadsError] = useState<string | null>(null);

  // Convert to Deal state
  const [convertModalOpen, setConvertModalOpen] = useState(false);
  const [convertFileNumber, setConvertFileNumber] = useState("");
  const [convertClosingDate, setConvertClosingDate] = useState("");
  const [converting, setConverting] = useState(false);
  // Local YYYY-MM-DD for the closing-date min attribute. Recomputed on render
  // so the picker won't drift past midnight in a long-open session.
  const todayLocalStr = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  })();
  const [convertResult, setConvertResult] = useState<{
    success: boolean;
    title: string;
    details: string[];
  } | null>(null);

  // Welcome email state
  const [sendingWelcome, setSendingWelcome] = useState(false);
  const [welcomeResult, setWelcomeResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailTemplates, setEmailTemplates] = useState<
    { id: string; name: string; body: string }[]
  >([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  // IDs of family members currently checked in the Send Email modal. Default
  // is just the lead the admin is viewing — the admin opts in to additional
  // co-purchasers / co-sellers, instead of being forced to send to everyone.
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<Set<string>>(
    new Set(),
  );
  // Per-recipient retainer-signed lookup. Populated when the Send Email modal
  // opens with the "Retainer Agreement Signed" template selected; lets the UI
  // show signed/unsigned badges per recipient before the admin hits Send. Keyed
  // by lead id; missing keys mean "not yet fetched".
  //
  // `signed` = a retainer_signatures row exists (client actually signed)
  // `has_pdf` = a lead_corporate_docs row with doc_type=retainer_agreement exists
  //
  // Both come from /api/admin/retainer-status. They can diverge because the
  // customer portal inserts the signature row synchronously but the PDF/blob/
  // doc-row step runs in a fire-and-forget async IIFE — if that fails the
  // signature exists without a PDF and the email send can't attach anything.
  const [retainerStatus, setRetainerStatus] = useState<
    Record<string, { signed: boolean; has_pdf: boolean; pdf_count: number; signature_count: number }>
  >({});
  const [retainerStatusLoading, setRetainerStatusLoading] = useState(false);

  const [expandedSections, setExpandedSections] = useState<string[]>([
    "personal",
    "current-address",
    "selling-address",
    "property-personal",
    "client-leads", // Partner Details — expanded by default
    "documents", // The intake agreement — expanded by default; the team reads it
                 // before they ever call the client, so it must not be a click away
  ]);

  // ── The agreement uploaded at intake ───────────────────────────────────────
  // The agreement was always in the database — it was just never read here. It
  // lands in one of two stores depending on how it arrived (intake form vs the
  // APS task in the client portal), and the route reads both; reading only
  // `lead_corporate_docs` is what made an existing customer's agreement show on
  // the deal page but not here. See leadApsDocuments.ts.
  const [apsDocs, setApsDocs] = useState<ApsDocRow[]>([]);
  const [apsDocsLoading, setApsDocsLoading] = useState(false);
  const [apsDocsError, setApsDocsError] = useState<string | null>(null);

  // ── Edit-mode state for the detail view ────────────────────────────────────
  type LeadEditForm = Pick<
    LeadUser,
    | "firstName"
    | "lastName"
    | "email"
    | "phone"
    | "addressStreet"
    | "addressUnit"
    | "addressCity"
    | "addressPostalCode"
    | "addressProvince"
    | "price"
    | "depositAmount"
    | "sellingAddressStreet"
    | "sellingAddressUnit"
    | "sellingAddressCity"
    | "sellingAddressProvince"
    | "sellingAddressPostalCode"
    | "sellingPrice"
    | "sellingDepositAmount"
  >;
  const buildEditForm = (l: LeadUser): LeadEditForm => ({
    firstName: l.firstName ?? "",
    lastName: l.lastName ?? "",
    email: l.email ?? "",
    phone: l.phone ?? "",
    addressStreet: l.addressStreet ?? "",
    addressUnit: l.addressUnit ?? "",
    addressCity: l.addressCity ?? "",
    addressPostalCode: l.addressPostalCode ?? "",
    addressProvince: l.addressProvince ?? "",
    price: l.price ?? "",
    depositAmount: l.depositAmount ?? "",
    sellingAddressStreet: l.sellingAddressStreet ?? "",
    sellingAddressUnit: l.sellingAddressUnit ?? "",
    sellingAddressCity: l.sellingAddressCity ?? "",
    sellingAddressProvince: l.sellingAddressProvince ?? "",
    sellingAddressPostalCode: l.sellingAddressPostalCode ?? "",
    sellingPrice: l.sellingPrice ?? "",
    sellingDepositAmount: l.sellingDepositAmount ?? "",
  });
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<LeadEditForm>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    addressStreet: "",
    addressUnit: "",
    addressCity: "",
    addressPostalCode: "",
    addressProvince: "",
    price: "",
    depositAmount: "",
    sellingAddressStreet: "",
    sellingAddressUnit: "",
    sellingAddressCity: "",
    sellingAddressProvince: "",
    sellingAddressPostalCode: "",
    sellingPrice: "",
    sellingDepositAmount: "",
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editResult, setEditResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const cancelEdit = () => {
    setIsEditing(false);
    setEditResult(null);
  };
  const startEditing = () => {
    if (!selectedLead) return;
    setEditForm(buildEditForm(selectedLead));
    setIsEditing(true);
    setEditResult(null);
  };
  const updateEditField = <K extends keyof LeadEditForm>(
    key: K,
    value: LeadEditForm[K],
  ) => setEditForm((prev) => ({ ...prev, [key]: value }));

  async function saveEdit() {
    if (!selectedLead) return;

    // A last name isn't mandatory — many records carry only a first name (and
    // corporate entities are identified by company name, not a personal name),
    // so requiring both wrongly blocked edits to unrelated fields like phone.
    // Individuals still need at least some name to identify them.
    const hasName = editForm.firstName.trim() || editForm.lastName.trim();
    if (!selectedLead.isCorporate && !hasName) {
      setEditResult({
        success: false,
        message: "A first or last name is required.",
      });
      return;
    }
    if (!editForm.email.trim()) {
      setEditResult({ success: false, message: "Email is required." });
      return;
    }

    setSavingEdit(true);
    setEditResult(null);
    try {
      const res = await fetch(`/api/admin/leads`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedLead.id, ...editForm }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      const updated = mapLead(data.lead);
      setLeads((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setSelectedLead(updated);
      setIsEditing(false);
      setEditResult({ success: true, message: "Lead updated successfully." });
    } catch (err: any) {
      setEditResult({
        success: false,
        message: err.message ?? "Failed to update lead.",
      });
    } finally {
      setSavingEdit(false);
    }
  }


  // ── Firm on the file (Nava Wilson vs iClosed LLP) ──────────────────────────
  // Saved on its own, NOT through the Edit form. Two reasons: it is a property
  // of the whole FILE rather than of this person (the server cascades it to
  // every co-lead), and it is the one field an admin flips on its own, on a
  // file they are otherwise only reading. Burying it behind Edit → Save would
  // make the common case the awkward one.
  // Which row is mid-save, not a bare boolean: the same handler backs the
  // per-row control in the LIST, where many files are on screen at once and
  // only the one being changed may show a spinner.
  const [firmSavingId, setFirmSavingId] = useState<string | null>(null);
  const [firmResult, setFirmResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  // The list has no result banner to write into, so it gets a transient toast.
  const [firmToast, setFirmToast] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  async function saveFirm(nextFirm: FirmKey, target?: LeadUser) {
    const lead = target ?? selectedLead;
    if (!lead || firmSavingId) return;
    if (resolveFirmKey(lead.firmKey) === nextFirm) return;

    setFirmSavingId(lead.id);
    setFirmResult(null);
    try {
      const res = await fetch(`/api/admin/leads`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, firmKey: nextFirm }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }

      // The server writes the firm to every lead in the family. Mirror that
      // locally or the co-leads in the list keep showing the old firm until a
      // reload — which reads as "the change did not take".
      const rootId = lead.parentLeadId ?? lead.id;
      const inFamily = (l: LeadUser) =>
        l.id === rootId || l.parentLeadId === rootId;
      setLeads((prev) =>
        prev.map((l) => (inFamily(l) ? { ...l, firmKey: nextFirm } : l)),
      );
      // Guarded by inFamily because the list can now change a file that is NOT
      // the one open behind it — an unguarded write would relabel whichever
      // lead happens to be selected.
      setSelectedLead((prev) =>
        prev && inFamily(prev) ? { ...prev, firmKey: nextFirm } : prev,
      );

      const warning = (data.warnings ?? [])[0] as string | undefined;
      const result = {
        success: !warning,
        message:
          warning ??
          `This file is now a ${FIRMS[nextFirm].label} file. Emails and the retainer will use its address and logo.`,
      };
      setFirmResult(result);
      setFirmToast(result);
    } catch (err: any) {
      const result = {
        success: false,
        message: err.message ?? "Failed to change the firm.",
      };
      setFirmResult(result);
      setFirmToast(result);
    } finally {
      setFirmSavingId(null);
    }
  }

  // Auto-dismiss the list toast. The detail banner stays until the next change,
  // which is what an admin reading one file expects.
  useEffect(() => {
    if (!firmToast) return;
    const t = setTimeout(() => setFirmToast(null), 4000);
    return () => clearTimeout(t);
  }, [firmToast]);

  // ── Referral agent (partner) linking ───────────────────────────────────────
  // Intake is the only place that could originally attach an agent, so a file
  // created before the agent was known had no way back. These drive the Partner
  // Details section's Add / Change / Remove / Notify actions, which write
  // through /api/admin/leads/[id]/agent.
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [partners, setPartners] = useState<ReferralPartner[]>([]);
  const [partnersLoading, setPartnersLoading] = useState(false);
  const [partnersError, setPartnersError] = useState<string | null>(null);
  const [partnerSearch, setPartnerSearch] = useState("");
  const [pickedPartnerId, setPickedPartnerId] = useState<string | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  const [notifyingAgent, setNotifyingAgent] = useState(false);
  // Shown in the Partner Details section (success/removal/notify) and inside the
  // modal (save failures — the modal stays open so the admin can retry).
  const [agentResult, setAgentResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const openAgentModal = async () => {
    if (!selectedLead) return;
    setPickedPartnerId(selectedLead.referralPartner?.id ?? null);
    setPartnerSearch("");
    setAgentResult(null);
    setAgentModalOpen(true);

    // Partners rarely change during a session, so fetch once and reuse.
    if (partners.length > 0) return;
    setPartnersLoading(true);
    setPartnersError(null);
    try {
      const res = await fetch(`/api/admin/partners`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setPartners(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setPartnersError(err.message ?? "Failed to load partners.");
    } finally {
      setPartnersLoading(false);
    }
  };

  // partnerId null clears the agent. The server applies the change to the whole
  // family (and their deals), so local state is patched family-wide to match —
  // otherwise opening a co-client would still show the old agent.
  async function saveAgent(partnerId: string | null) {
    if (!selectedLead) return;
    setSavingAgent(true);
    setAgentResult(null);
    try {
      const res = await fetch(`/api/admin/leads/${selectedLead.id}/agent`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }

      const familyIds = new Set(getFamilyLeadIds(selectedLead));
      const applyAgent = (l: LeadUser): LeadUser =>
        familyIds.has(l.id)
          ? {
              ...l,
              referralPartner: (data.partner as ReferralPartner) ?? null,
              // The server clears the free-text intake fields on both link and
              // unlink; mirror that so the card doesn't fall back to a name the
              // DB no longer holds.
              referralAgentName: null,
              referralAgentCompany: null,
              referralAgentEmail: null,
            }
          : l;
      setLeads((prev) => prev.map(applyAgent));
      setSelectedLead((prev) => (prev ? applyAgent(prev) : prev));

      const partnerName = data.partner?.agent_name ?? "Agent";
      const parts: string[] = [
        partnerId
          ? `${partnerName} linked to this file.`
          : "Agent removed from this file.",
      ];
      if (data.dealsUpdated > 0) {
        parts.push(
          `Updated ${data.leadsUpdated} client record${data.leadsUpdated === 1 ? "" : "s"} and ${data.dealsUpdated} file${data.dealsUpdated === 1 ? "" : "s"}.`,
        );
      }
      if (Array.isArray(data.warnings)) parts.push(...data.warnings);

      setAgentModalOpen(false);
      setAgentResult({ success: true, message: parts.join(" ") });
    } catch (err: any) {
      setAgentResult({
        success: false,
        message: err.message ?? "Failed to update the agent.",
      });
    } finally {
      setSavingAgent(false);
    }
  }

  const removeAgent = () => {
    if (!selectedLead) return;
    if (
      !confirm(
        "Remove the referral agent from this file? They'll stop being copied on client emails.",
      )
    )
      return;
    saveAgent(null);
  };

  // Catch-up send for an agent linked AFTER the client activated their account —
  // the automatic one-shot already passed, so it never fired for them.
  async function notifyAgent() {
    if (!selectedLead) return;
    setNotifyingAgent(true);
    setAgentResult(null);
    try {
      const res = await fetch(`/api/admin/leads/${selectedLead.id}/agent`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }

      if (!data.sent) {
        setAgentResult({
          success: false,
          message: data.reason ?? "Nothing to send.",
        });
        return;
      }

      const markSent = (l: LeadUser): LeadUser =>
        l.id === selectedLead.id ? { ...l, agentSignupEmailSent: true } : l;
      setLeads((prev) => prev.map(markSent));
      setSelectedLead((prev) => (prev ? markSent(prev) : prev));
      setAgentResult({
        success: true,
        message: `Signup notification sent to ${selectedLead.referralPartner?.agent_email ?? "the agent"}.`,
      });
    } catch (err: any) {
      setAgentResult({
        success: false,
        message: err.message ?? "Failed to notify the agent.",
      });
    } finally {
      setNotifyingAgent(false);
    }
  }

  // A DATE column arrives as "YYYY-MM-DD", but a timestamp would arrive with a
  // time part that <input type="date"> silently rejects. Keep the date half.
  const toDateOnly = (value: unknown): string | undefined => {
    if (!value) return undefined;
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
    return match ? match[1] : undefined;
  };

  const mapLead = (l: any): LeadUser => ({
    id: l.id,
    firstName: l.first_name ?? "",
    lastName: l.last_name ?? "",
    email: l.email ?? "",
    phone: l.phone ?? "",
    isCorporate: l.is_corporate ?? false,
    corporateName: l.corporate_name,
    incNumber: l.inc_number,
    addressStreet: l.address_street,
    addressUnit: l.address_unit,
    addressCity: l.address_city,
    addressPostalCode: l.address_postal_code,
    addressProvince: l.address_province,
    propertyType: l.property_type,
    ownershipHistory: l.ownership_history,
    maritalStatus: l.marital_status,
    citizenshipStatus: l.citizenship_status,
    occupation: l.occupation,
    employerPhone: l.employer_phone,
    status: l.status ?? "New",
    lead_type: l.lead_type,
    price: l.price,
    // selling_price and both deposits are numeric in the DB — stringify so the
    // edit form (all text inputs) can round-trip them without a type mismatch.
    sellingPrice: l.selling_price != null ? String(l.selling_price) : undefined,
    depositAmount: l.deposit_amount != null ? String(l.deposit_amount) : undefined,
    sellingDepositAmount:
      l.selling_deposit_amount != null ? String(l.selling_deposit_amount) : undefined,
    // DATE columns come back as "YYYY-MM-DD"; trimmed to be safe so the value
    // drops straight into a <input type="date">.
    closingDate: toDateOnly(l.closing_date),
    sellingClosingDate: toDateOnly(l.selling_closing_date),
    created_at: l.created_at,
    service: l.service,
    subService: l.sub_service,
    apsSigned: l.aps_signed,
    referralSource: l.referral_source,
    referralPartner: l.referral_partner ?? null,
    referralAgentName: l.referral_agent_name ?? null,
    referralAgentCompany: l.referral_agent_company ?? null,
    referralAgentEmail: l.referral_agent_email ?? null,
    agentSignupEmailSent: l.agent_signup_email_sent ?? false,
    firmKey: l.firm_key ?? undefined,
    sellingAddressStreet: l.selling_address_street,
    sellingAddressUnit: l.selling_address_unit,
    sellingAddressCity: l.selling_address_city,
    sellingAddressPostalCode: l.selling_address_postal_code,
    sellingAddressProvince: l.selling_address_province,
    parentLeadId: l.parent_lead_id ?? null,
    coPersonRole:
      l.co_person_role === "purchaser" || l.co_person_role === "seller"
        ? l.co_person_role
        : null,
  });

  // ── Fetch leads from local admin API ─────────────────────
  useEffect(() => {
    async function fetchLeads() {
      setLeadsLoading(true);
      setLeadsError(null);
      try {
        // Use the admin portal's own API to fetch leads
        const res = await fetch(`/api/admin/leads`);
        const data = await res.json();
        if (data.success) {
          const mapped: LeadUser[] = (data.leads ?? []).map(mapLead);
          setLeads(mapped);
        } else {
          setLeadsError(data.error ?? "Failed to load leads.");
        }
      } catch (err) {
        setLeadsError("Cannot connect to customer portal API.");
      } finally {
        setLeadsLoading(false);
      }
    }
    fetchLeads();
  }, []);

  // ── Supabase Realtime: auto-append new leads ─────────────
  useEffect(() => {
    const channel = supabase
      .channel("leads-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "leads" },
        (payload) => {
          const newLead = mapLead(payload.new);
          setLeads((prev) => {
            if (prev.some((l) => l.id === newLead.id)) return prev;
            return [newLead, ...prev];
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleAddClient = (e: React.FormEvent) => {
    e.preventDefault();
    setIsAddModalOpen(false);
  };

  const openLead = (lead: LeadUser) => {
    setSelectedLead(lead);
    setConvertResult(null);
    setAgentResult(null);
    setIsEditing(false);
    setEditResult(null);
    // Seed the Convert dialog with the closing date the client already gave at
    // intake. Still fully editable — the admin can overwrite or clear it, and
    // whatever is in the box at Convert time is what the deal gets.
    setConvertClosingDate(lead.closingDate ?? "");
    setView("DETAIL");
    router.push(`/admin/leads?lead=${lead.id}`);
  };

  const openLeadForEdit = (lead: LeadUser) => {
    setSelectedLead(lead);
    setConvertResult(null);
    setAgentResult(null);
    setEditForm(buildEditForm(lead));
    setIsEditing(true);
    setEditResult(null);
    setView("DETAIL");
    router.push(`/admin/leads?lead=${lead.id}`);
  };

  const getLeadName = (id: string) => {
    const match = leads.find((l) => l.id === id);
    return match ? `${match.firstName} ${match.lastName}` : null;
  };

  const getLeadDisplayName = (id: string) => {
    if (selectedLead?.id === id) {
      return `${selectedLead.firstName} ${selectedLead.lastName}`.trim();
    }
    return getLeadName(id) ?? "Unknown Lead";
  };

  const handleDeleteLead = async (leadId: string, name: string) => {
    if (!confirm(`Delete lead "${name}"?`)) return;
    try {
      const res = await fetch(`/api/admin/leads?id=${leadId}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setLeads((prev) => prev.filter((l) => l.id !== leadId));
      } else {
        alert("Failed to delete lead: " + (data.error ?? "Unknown error"));
      }
    } catch {
      alert("Error deleting lead.");
    }
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  // ── Convert to Deal ────────────────────────────────────────────────────────
  const getFamilyLeadIds = (lead: LeadUser) => {
    const rootLeadId = lead.parentLeadId ?? lead.id;
    return leads
      .filter((l) => l.id === rootLeadId || l.parentLeadId === rootLeadId)
      .map((l) => l.id);
  };

  async function handleConvertToDeal() {
    if (!selectedLead) return;

    // Block past closing dates before we hit the server. The server enforces
    // the same rule, but catching it here gives instant feedback and avoids
    // a wasted round-trip.
    if (convertClosingDate && convertClosingDate < todayLocalStr) {
      setConvertResult({
        success: false,
        title: "Closing date can't be in the past.",
        details: ["Pick today or a future date to create the deal."],
      });
      return;
    }

    setConverting(true);
    setConvertResult(null);
    try {
      const familyLeadIds = getFamilyLeadIds(selectedLead);
      const convertFamily = familyLeadIds.length > 1;

      const res = await fetch(`/api/admin/convert-lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: selectedLead.id,
          file_number: convertFileNumber.trim() || undefined,
          closing_date: convertClosingDate || undefined,
          convert_family: convertFamily || undefined,
        }),
      });
      const data = await res.json();
      if (data.success || Array.isArray(data.results)) {
        if (Array.isArray(data.results)) {
          const allResults = data.results as any[];
          // Narrow to the family the admin actually sees in their list. The
          // server may auto-expand to a wider family (e.g. when an intake
          // address-match silently linked this lead as a co-purchaser of
          // another deal), but the report should only mention leads the admin
          // recognizes as related to the one they clicked Convert on.
          const familyIdSet = new Set(familyLeadIds);
          const results = allResults.filter((r) => familyIdSet.has(r.lead_id));
          const convertedIds = new Set(results.map((r) => r.lead_id));
          const selectedResult = results.find((r) => r.lead_id === selectedLead.id);

          // Mark all converted/skipped family leads as Converted in local state.
          setLeads((prev) =>
            prev.map((l) => (convertedIds.has(l.id) ? { ...l, status: "Converted" } : l)),
          );
          setSelectedLead((prev) => {
            if (!prev) return null;
            return convertedIds.has(prev.id) ? { ...prev, status: "Converted" } : prev;
          });

          const createdCount = results.filter((r) => r.created).length;
          const alreadyConvertedCount = results.filter((r) => r.already_converted).length;
          const invitedLeads = results
            .filter((r) => r.invite_sent)
            .map((r) => getLeadDisplayName(r.lead_id));
          const alreadyConvertedLeads = results
            .filter((r) => r.already_converted && r.lead_id !== selectedLead.id)
            .map((r) => getLeadDisplayName(r.lead_id));
          const alreadyHasLoginLeads = results
            .filter((r: any) => r.already_has_login)
            .map((r) => getLeadDisplayName(r.lead_id));
          const failedLeads = results
            .filter((r) => !r.success)
            .map((r) => {
              const name = getLeadDisplayName(r.lead_id);
              // Include the reason (e.g. "File number ... already exists") so a
              // bad manual file number is explained, not just flagged.
              return (r as any).error ? `${name} — ${(r as any).error}` : name;
            });
          const failedCount = failedLeads.length;
          const hadErrors = data.had_errors ?? failedCount > 0;
          const details: string[] = [];
          let title: string;

          if (selectedResult?.already_converted) {
            title = `${selectedLead.firstName} ${selectedLead.lastName} is already converted.`;
            details.push("No new deal was created for the selected lead.");
          } else {
            title =
              createdCount === 1
                ? `${selectedLead.firstName} ${selectedLead.lastName} was converted successfully.`
                : `${createdCount} leads were converted successfully.`;
          }

          if (invitedLeads.length > 0) {
            details.push(`Invite sent: ${invitedLeads.join(", ")}`);
          }
          if (alreadyHasLoginLeads.length > 0) {
            details.push(`Already had portal access: ${alreadyHasLoginLeads.join(", ")}`);
          }
          if (alreadyConvertedLeads.length > 0) {
            details.push(`Already converted: ${alreadyConvertedLeads.join(", ")}`);
          } else if (!selectedResult?.already_converted && alreadyConvertedCount > 0) {
            details.push(`${alreadyConvertedCount} linked lead(s) were already converted.`);
          }
          if (failedLeads.length > 0) {
            details.push(`Failed: ${failedLeads.join(", ")}`);
          }

          setConvertResult({
            success: !hadErrors,
            title,
            details,
          });
        } else {
          const title = `${selectedLead.firstName} ${selectedLead.lastName} was converted successfully.`;
          const details: string[] = [];

          if (data.invite_sent) {
            details.push(`Invite sent: ${selectedLead.firstName} ${selectedLead.lastName}`);
          } else if (data.already_has_login) {
            details.push(`Already had portal access: ${selectedLead.firstName} ${selectedLead.lastName}`);
          } else {
            details.push("No invite was sent. Create portal access manually if needed.");
          }

          setConvertResult({
            success: true,
            title,
            details,
          });

          // Update the lead status in local state
          setLeads((prev) =>
            prev.map((l) => (l.id === selectedLead.id ? { ...l, status: "Converted" } : l)),
          );
          setSelectedLead((prev) => (prev ? { ...prev, status: "Converted" } : null));
        }
      } else {
        setConvertResult({
          success: false,
          title: "Conversion failed.",
          details: [data.error ?? "Please try again."],
        });
      }
    } catch (err) {
      setConvertResult({
        success: false,
        title: "Network error.",
        details: ["Please try again."],
      });
    } finally {
      setConverting(false);
    }
  }

  // ── Fetch email templates for picker ────────────────────────────────────────
  async function fetchEmailTemplates() {
    try {
      const res = await fetch("/api/admin/email-templates");
      const data = await res.json();
      if (Array.isArray(data)) {
        setEmailTemplates(data.filter((t: any) => t.is_active && t.body));
      }
    } catch {
      // silent
    }
  }

  // ── Send Email with selected template to all related clients ─────────────
  // Sends to the primary lead + every co-purchaser/co-seller (deduped by email)
  // via the family endpoint. Reports per-recipient outcomes back to the admin.
  async function sendEmailToFamily(templateId?: string, leadIds?: string[]) {
    if (!selectedLead || selectedLead.status !== "Converted") {
      setWelcomeResult({
        success: false,
        message: "Email can only be sent after the lead has been converted to a deal.",
      });
      return;
    }

    if (leadIds && leadIds.length === 0) {
      setWelcomeResult({
        success: false,
        message: "Select at least one recipient.",
      });
      return;
    }

    setSendingWelcome(true);
    setWelcomeResult(null);
    try {
      const payload: any = { lead_id: selectedLead.id };
      if (templateId) payload.template_id = templateId;
      if (leadIds && leadIds.length > 0) payload.lead_ids = leadIds;

      const res = await fetch(`/api/admin/send-lead-family-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      const results: any[] = Array.isArray(data?.results) ? data.results : [];

      if (!res.ok && results.length === 0) {
        setWelcomeResult({
          success: false,
          message: data?.error ?? "Failed to send email.",
        });
        return;
      }

      const total: number = data?.total ?? results.length;
      const sent: number = data?.sent ?? 0;
      const failed: number = data?.failed ?? 0;
      const sentEmails = results
        .filter((r) => r.success && !r.skipped)
        .map((r) => r.email);
      const failures = results
        .filter((r) => !r.success)
        .map((r) => `${r.email} (${r.error ?? "failed"})`);

      if (failed === 0 && sent > 0) {
        setWelcomeResult({
          success: true,
          message: `Email sent to ${sent} client(s): ${sentEmails.join(", ")}`,
        });
        setEmailModalOpen(false);
      } else if (sent > 0) {
        setWelcomeResult({
          success: false,
          message: `Sent ${sent} of ${total}. Failed: ${failures.join(", ")}`,
        });
      } else {
        // Retainer-agreement template fails when no signed PDF is on file. We
        // collapse the per-recipient list into one clean message when every
        // failure is the same retainer-missing-PDF case, distinguishing the
        // two flavours of it: the client never signed at all vs. they signed
        // but iclosed_web's async PDF/blob step didn't persist the doc.
        const allRetainerUnsigned =
          results.length > 0 &&
          results.every(
            (r) =>
              !r.success &&
              typeof r.error === "string" &&
              r.error.toLowerCase().includes("retainer agreement is not signed"),
          );
        const someSignedButNoPdf = allRetainerUnsigned
          && Array.from(selectedRecipientIds).some(
            (id) => retainerStatus[id]?.signed === true && retainerStatus[id]?.has_pdf === false,
          );

        setWelcomeResult({
          success: false,
          message: someSignedButNoPdf
            ? "Client signed the retainer but the signed PDF isn't on file yet — the agreement can't be attached. Re-trigger PDF generation in the customer portal."
            : allRetainerUnsigned
              ? "Retainer agreement is still not signed — nothing to attach."
              : failures.length > 0
                ? `All sends failed. First error: ${failures[0]}`
                : data?.error ?? "Failed to send email.",
        });
      }
    } catch (err) {
      setWelcomeResult({
        success: false,
        message: "Network error sending email.",
      });
    } finally {
      setSendingWelcome(false);
    }
  }

  const inputClasses =
    "w-full px-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all placeholder:text-slate-300";
  const selectClasses =
    "w-full px-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all appearance-none cursor-pointer";

  const SectionHeader = ({
    title,
    id,
    icon: Icon,
    count,
  }: {
    title: string;
    id: string;
    icon: any;
    /** Optional tally shown beside the title — so a collapsed section still
     *  tells the admin whether there is anything in it. */
    count?: number;
  }) => (
    <button
      onClick={() => toggleSection(id)}
      className={`w-full flex items-center justify-between px-6 py-4 transition-all duration-200 border-b border-slate-100 ${
        expandedSections.includes(id) ? "bg-slate-50/50" : "hover:bg-slate-50"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`p-2 rounded-lg ${expandedSections.includes(id) ? "bg-brand-primary text-white shadow-sm" : "bg-slate-100 text-slate-500"}`}
        >
          <Icon size={18} />
        </div>
        <h3 className="font-bold text-slate-800 tracking-tight">{title}</h3>
        {typeof count === "number" && count > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 text-slate-600 border border-slate-200">
            {count}
          </span>
        )}
      </div>
      <ChevronDown
        size={20}
        className={`text-slate-400 transition-transform duration-300 ${expandedSections.includes(id) ? "rotate-180" : ""}`}
      />
    </button>
  );

  // Determine whether a co-lead is a co-purchaser or co-seller.
  //   1. Trust the co-lead's own lead_type when it specifies a single side.
  //   2. For "Purchase & Sale" co-leads, compare the co-lead's purchase and
  //      selling street addresses against the parent's. The side whose
  //      address the co-lead shares with the parent is the side they joined
  //      — e.g. matching purchase address, different selling address ⇒
  //      they're co-purchasers on the parent's deal (their own sale is
  //      unrelated).
  //   3. Both sides match (co-lead inserted via the same intake as the
  //      parent, so both addresses got mirrored): fall back to the
  //      selling_address_street presence heuristic, then parent's lead_type.
  //      Default to co-purchaser.
  const getCoRole = (
    coLead: Pick<LeadUser, "lead_type" | "addressStreet" | "sellingAddressStreet" | "coPersonRole">,
    parent?: Pick<LeadUser, "lead_type" | "addressStreet" | "sellingAddressStreet"> | null,
  ): "co-purchaser" | "co-seller" => {
    // 1. Trust the explicit co_person_role recorded at intake. This is the
    //    authoritative source — the address-matching heuristic below can't
    //    tell purchaser from seller on Purchase & Sale parents where both
    //    co-leads share both addresses.
    if (coLead.coPersonRole === "purchaser") return "co-purchaser";
    if (coLead.coPersonRole === "seller") return "co-seller";

    const ownLt = (coLead.lead_type ?? "").toLowerCase().trim();
    const ownHasPurchase = ownLt.includes("purchase");
    const ownHasSale = ownLt.includes("sale");
    if (ownHasSale && !ownHasPurchase) return "co-seller";
    if (ownHasPurchase && !ownHasSale) return "co-purchaser";

    const norm = (s?: string) => (s ?? "").trim().toLowerCase();
    if (parent) {
      const coPurch = norm(coLead.addressStreet);
      const coSale = norm(coLead.sellingAddressStreet);
      const pPurch = norm(parent.addressStreet);
      const pSale = norm(parent.sellingAddressStreet);
      const purchaseMatch = !!coPurch && !!pPurch && coPurch === pPurch;
      const saleMatch = !!coSale && !!pSale && coSale === pSale;
      if (purchaseMatch && !saleMatch) return "co-purchaser";
      if (saleMatch && !purchaseMatch) return "co-seller";
    }

    if (coLead.sellingAddressStreet) return "co-seller";
    const parentLt = (parent?.lead_type ?? "").toLowerCase().trim();
    if (parentLt === "sale") return "co-seller";
    return "co-purchaser";
  };

  // Build a single lowercased haystack string per lead covering every field
  // an admin might search by: name (incl. corporate / co-purchaser / co-seller),
  // contact info, both addresses, lead type & service, price, status label,
  // and demographic fields. Multi-word queries are split on whitespace and
  // ALL parts must appear — so "john toronto" finds a John in Toronto without
  // requiring a single contiguous substring.
  const buildLeadHaystack = (l: LeadUser): string => {
    const coLeads = leads.filter((x) => x.parentLeadId === l.id);
    const statusLabel = l.status === "Converted" ? "Converted" : "Active";
    const parts: Array<string | undefined | null> = [
      l.firstName,
      l.lastName,
      `${l.firstName ?? ""} ${l.lastName ?? ""}`,
      l.corporateName,
      l.incNumber,
      l.email,
      l.phone,
      l.employerPhone,
      l.addressStreet,
      l.addressUnit,
      l.addressCity,
      l.addressProvince,
      l.addressPostalCode,
      [l.addressStreet, l.addressUnit, l.addressCity, l.addressProvince, l.addressPostalCode]
        .filter(Boolean)
        .join(" "),
      l.sellingAddressStreet,
      l.sellingAddressCity,
      l.sellingAddressProvince,
      l.sellingAddressPostalCode,
      [l.sellingAddressStreet, l.sellingAddressCity, l.sellingAddressProvince, l.sellingAddressPostalCode]
        .filter(Boolean)
        .join(" "),
      l.lead_type,
      l.service,
      l.subService,
      l.propertyType,
      l.ownershipHistory,
      l.maritalStatus,
      l.citizenshipStatus,
      l.occupation,
      l.referralSource,
      l.price,
      statusLabel,
      // The firm label, so "nava" / "iclosed llp" narrows the list to one firm.
      FIRMS[resolveFirmKey(l.firmKey)].label,
      // Co-purchaser / co-seller names so searching by a family member finds
      // the primary record they roll up under.
      ...coLeads.flatMap((c) => [c.firstName, c.lastName, `${c.firstName ?? ""} ${c.lastName ?? ""}`, c.email, c.corporateName]),
    ];
    return parts.filter(Boolean).join(" | ").toLowerCase();
  };

  const filteredLeads = leads
    .filter((l) => !l.parentLeadId) // Only show primary/standalone leads; co-purchasers/co-sellers visible in detail view
    .filter((l) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      const haystack = buildLeadHaystack(l);
      // Split on commas, dots, semicolons, pipes, slashes, AND whitespace so
      // pasting a full address ("123 Main St, Toronto, ON") works: each part
      // becomes its own term and is required to appear somewhere in the
      // haystack. Without this, "Street," (with comma attached) would never
      // match because the haystack stores "Street" without the comma.
      const terms = q.split(/[\s,.;|/]+/).filter(Boolean);
      return terms.every((term) => haystack.includes(term));
    });

  const isConverted = selectedLead?.status === "Converted";
  const isPurchaseAndSale = (() => {
    const lt = (selectedLead?.lead_type ?? "").toLowerCase();
    return lt.includes("purchase") && lt.includes("sale");
  })();
  // A Sale-only lead still renders under the "Purchase Property Address"
  // heading, but its single `price` IS the sale price — label it accordingly so
  // the amount isn't read as a purchase figure.
  const isSaleOnly = (() => {
    const lt = (selectedLead?.lead_type ?? "").toLowerCase();
    return lt.includes("sale") && !lt.includes("purchase");
  })();

  // Prices arrive from intake as free text ("850000", "$850,000", "TBD"), and
  // leads.price is a text column. Format only when the value is actually
  // numeric; otherwise pass it through untouched so nothing an admin typed is
  // silently mangled.
  const formatPriceDisplay = (raw?: string | null) => {
    const value = (raw ?? "").trim();
    if (!value) return "";
    const numeric = Number(value.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) return value;
    return `$${numeric.toLocaleString("en-CA")}`;
  };

  // Family of related clients to receive the email when admin hits Send Email.
  // Walks up to the primary if the admin is viewing a co-lead, then includes
  // every co-purchaser/co-seller. Dedupes by lowercased email; drops empties.
  const emailRecipients = (() => {
    if (!selectedLead) return [] as Array<{ lead: LeadUser; role: string }>;
    const primary = selectedLead.parentLeadId
      ? leads.find((l) => l.id === selectedLead.parentLeadId) ?? selectedLead
      : selectedLead;
    const coLeads = leads.filter((l) => l.parentLeadId === primary.id);
    const list: Array<{ lead: LeadUser; role: string }> = [
      { lead: primary, role: "Primary" },
      ...coLeads.map((l) => ({
        lead: l,
        role: getCoRole(l, primary) === "co-seller" ? "Co-Seller" : "Co-Purchaser",
      })),
    ];
    const seen = new Set<string>();
    return list.filter(({ lead }) => {
      const key = (lead.email ?? "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();

  // The "Retainer Agreement Signed" template attaches the signed PDF, so it
  // can only be delivered after the client signs. We want the modal to surface
  // that constraint per recipient instead of letting the admin click Send and
  // get a generic failure. Matching the backend's substring rule keeps the
  // logic in lockstep with send-lead-family-email.
  const selectedTemplate = emailTemplates.find((t) => t.id === selectedTemplateId);
  const isRetainerTemplateSelected = (selectedTemplate?.name ?? "")
    .toLowerCase()
    .includes("retainer agreement");

  // Fetch signed-retainer status for every recipient as soon as the modal opens
  // with the retainer template selected. Re-fetches when the recipient list
  // changes (e.g. admin switches the family they're viewing). Failures are
  // non-blocking — the UI just won't show badges, and the backend will still
  // enforce the rule on Send.
  useEffect(() => {
    if (!emailModalOpen || !isRetainerTemplateSelected) return;
    const ids = emailRecipients.map(({ lead }) => lead.id);
    if (ids.length === 0) return;
    let cancelled = false;
    setRetainerStatusLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/retainer-status?lead_ids=${encodeURIComponent(ids.join(","))}`,
        );
        const data = await res.json();
        if (!cancelled && data?.success && data.status) {
          setRetainerStatus(data.status);
        }
      } catch {
        // Silent — admin will still see the backend's send-time error.
      } finally {
        if (!cancelled) setRetainerStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [emailModalOpen, isRetainerTemplateSelected, emailRecipients.map((r) => r.lead.id).join(",")]);

  // Load the agreement as soon as a lead is opened. The route does the family
  // resolution and reads both stores; everything here just renders the answer.
  useEffect(() => {
    const leadId = view === "DETAIL" ? selectedLead?.id : undefined;
    let cancelled = false;
    (async () => {
      if (!leadId) {
        setApsDocs([]);
        setApsDocsError(null);
        setApsDocsLoading(false);
        return;
      }
      // Drop the previous lead's agreement before fetching: showing one
      // client's agreement under another client's name, even for a moment, is
      // the one failure mode this section must not have.
      setApsDocs([]);
      setApsDocsLoading(true);
      setApsDocsError(null);
      try {
        const res = await fetch(
          `/api/admin/leads/${encodeURIComponent(leadId)}/aps-documents`,
        );
        const data = await res.json();
        if (cancelled) return;
        if (data?.success && Array.isArray(data.documents)) {
          setApsDocs(data.documents as ApsDocRow[]);
        } else {
          // Say so rather than rendering an empty list — "no agreement" and
          // "we couldn't look" lead staff to opposite conclusions before a
          // client call.
          setApsDocs([]);
          setApsDocsError(
            typeof data?.error === "string" ? data.error : "Could not load the agreement",
          );
        }
      } catch {
        if (!cancelled) {
          setApsDocs([]);
          setApsDocsError("Could not load the agreement");
        }
      } finally {
        if (!cancelled) setApsDocsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, selectedLead?.id]);

  // Open in a new tab. Goes through openDocForViewing so private blobs stream
  // via the auth-gated proxy and a HEIC photo is converted to something a
  // browser will actually render inline. That helper takes the stored column
  // names, hence the shim.
  const viewApsDoc = async (doc: ApsDocRow) => {
    if (!doc.fileUrl) return;
    const opened = await openDocForViewing({
      file_url: doc.fileUrl,
      file_name: doc.fileName,
    });
    if (!opened) {
      alert("Could not open the file — allow pop-ups and try again.");
    }
  };

  // Fetch-then-blob so a cross-origin Blob URL downloads instead of navigating
  // away; falls back to a plain anchor when fetch is blocked by CORS.
  const downloadApsDoc = async (doc: ApsDocRow) => {
    if (!doc.fileUrl) return;
    const href = docDownloadHref(doc.fileUrl);
    try {
      const res = await fetch(href, {
        credentials: docFetchCredentials(doc.fileUrl),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = doc.fileName || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      const a = document.createElement("a");
      a.href = href;
      a.download = doc.fileName || "download";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  // ── DETAIL VIEW ───────────────────────────────────────────────────────────
  if (view === "DETAIL" && selectedLead) {
    return (
      <div key={selectedLead.id} className="max-w-6xl mx-auto space-y-4 sm:space-y-6 animate-in slide-in-from-right duration-300 py-2 sm:py-4 pb-20">
        {/* Back button */}
        <button
          onClick={() => {
            setView("LIST");
            setSelectedLead(null);
            router.push("/admin/leads");
          }}
          className="flex items-center gap-2 text-slate-500 font-bold text-sm hover:text-brand-primary transition-colors"
        >
          <ArrowLeft size={18} /> Back to Leads Dashboard
        </button>

        {/* Co-purchaser/co-seller relationship banners */}
        {selectedLead.parentLeadId && (() => {
          const parent = leads.find((l) => l.id === selectedLead.parentLeadId) ?? null;
          const role = getCoRole(selectedLead, parent);
          const isSeller = role === "co-seller";
          const containerCls = isSeller
            ? "border-amber-200 bg-amber-50 text-amber-800"
            : "border-blue-200 bg-blue-50 text-blue-800";
          const linkHoverCls = isSeller ? "hover:text-amber-600" : "hover:text-blue-600";
          const badgeCls = isSeller
            ? "bg-amber-100 text-amber-700 border-amber-200"
            : "bg-blue-100 text-blue-700 border-blue-200";
          return (
            <div className={`flex items-center gap-3 px-5 py-4 rounded-xl border text-sm font-semibold ${containerCls}`}>
              <Link2 size={18} className="flex-shrink-0" />
              <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tight border ${badgeCls}`}>
                {isSeller ? "Co-Seller" : "Co-Purchaser"}
              </span>
              <span>
                of{" "}
                <button
                  onClick={() => {
                    if (parent) openLead(parent);
                  }}
                  className={`underline font-bold transition-colors ${linkHoverCls}`}
                >
                  {getLeadName(selectedLead.parentLeadId) ?? "Primary Lead"}
                </button>
              </span>
            </div>
          );
        })()}
        {leads.some((l) => l.parentLeadId === selectedLead.id) && (() => {
          const children = leads.filter((l) => l.parentLeadId === selectedLead.id);
          const coPurchasers = children.filter(
            (c) => getCoRole(c, selectedLead) === "co-purchaser",
          );
          const coSellers = children.filter(
            (c) => getCoRole(c, selectedLead) === "co-seller",
          );

          const renderList = (
            list: typeof children,
            label: string,
            colorClass: string,
            hoverClass: string,
          ) =>
            list.length === 0 ? null : (
              <div className={`flex items-center gap-3 px-5 py-4 rounded-xl border text-sm font-semibold ${colorClass}`}>
                <Users size={18} className="flex-shrink-0" />
                <span>
                  {label}:{" "}
                  {list.map((cp, i) => (
                    <span key={cp.id}>
                      <button
                        onClick={() => openLead(cp)}
                        className={`underline font-bold transition-colors ${hoverClass}`}
                      >
                        {cp.firstName} {cp.lastName}
                      </button>
                      {i < list.length - 1 ? ", " : ""}
                    </span>
                  ))}
                </span>
              </div>
            );

          return (
            <>
              {renderList(coPurchasers, "Co-purchasers", "border-green-200 bg-green-50 text-green-800", "hover:text-green-600")}
              {renderList(coSellers, "Co-sellers", "border-amber-200 bg-amber-50 text-amber-800", "hover:text-amber-600")}
            </>
          );
        })()}

        {/* "Referred By" box removed — the partner is shown in the Partner
            Details section below. */}

        {/* Top Identity Card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-5">
            <div className="w-16 h-16 bg-brand-light rounded-2xl flex items-center justify-center text-brand-primary">
              {selectedLead.isCorporate ? (
                <Building2 size={32} />
              ) : (
                <UserIcon size={32} />
              )}
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">
                {selectedLead.isCorporate
                  ? "Corporate Entity"
                  : "Individual Profile"}
              </h1>
              <h2 className="text-2xl font-black text-slate-900 leading-none">
                {selectedLead.firstName} {selectedLead.lastName}
              </h2>
              <p className="text-slate-500 font-medium mt-1">
                {selectedLead.email}
              </p>
            </div>
          </div>

          {/* ── Convert to Deal button ── */}
          <div className="flex items-center gap-3 flex-wrap">
            {isEditing && (
              <>
                <button
                  onClick={cancelEdit}
                  disabled={savingEdit}
                  className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-300 text-slate-600 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-slate-50 transition-all disabled:opacity-60"
                >
                  <X size={14} /> Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={savingEdit}
                  className="flex items-center gap-2 px-6 py-2.5 bg-brand-primary text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-brand-primaryHover transition-all shadow-lg active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {savingEdit ? (
                    <><Loader2 size={14} className="animate-spin" /> Saving...</>
                  ) : (
                    <><Save size={14} /> Save Changes</>
                  )}
                </button>
              </>
            )}
            {!isEditing && (
              <button
                onClick={startEditing}
                className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-300 text-slate-700 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-slate-50 hover:border-brand-primary hover:text-brand-primary transition-all shadow-sm active:scale-95"
              >
                <Edit3 size={14} /> Edit
              </button>
            )}
            {isConverted ? (
              <div className="flex items-center gap-2 px-5 py-2.5 bg-green-50 border border-green-200 text-green-700 rounded-xl text-xs font-black uppercase tracking-widest">
                <CheckCircle2 size={14} /> Already Converted
              </div>
            ) : (
              <button
                onClick={() => {
                  setConvertModalOpen(true);
                  setConvertResult(null);
                }}
                className="flex items-center gap-2 px-6 py-2.5 bg-brand-primary text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-brand-primaryHover transition-all shadow-lg active:scale-95"
              >
                <Zap size={14} /> Convert to Deal
              </button>
            )}
            <button
              onClick={() => {
                if (!isConverted) {
                  setWelcomeResult({
                    success: false,
                    message: "Email can only be sent after the lead has been converted to a deal.",
                  });
                  return;
                }
                fetchEmailTemplates();
                setSelectedTemplateId("");
                setSelectedRecipientIds(new Set([selectedLead.id]));
                setEmailModalOpen(true);
              }}
              disabled={sendingWelcome || !isConverted}
              className="flex items-center gap-2 px-6 py-2.5 bg-emerald-600 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-emerald-700 transition-all shadow-lg active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Send size={14} /> Send Email
            </button>
            {/* <button className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg active:scale-95">
              <History size={14} /> View History
            </button> */}
          </div>
        </div>


        {/* ── Firm ── which entity this FILE is retained under. Drives the
            address every automated email is sent from, the lockup at the foot
            of those emails, and the retainer's logo and wording. Applies to the
            whole family, not just this person. */}
        {(() => {
          const current = resolveFirmKey(selectedLead.firmKey);
          const isCoLead = !!selectedLead.parentLeadId;
          const savingFirm = firmSavingId === selectedLead.id;
          return (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-slate-100 text-slate-500">
                    <ShieldCheck size={18} />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-800 tracking-tight">Firm</h3>
                    <p className="text-xs font-medium text-slate-500 mt-0.5">
                      Sets the sending address, the email logo and the retainer wording
                      {isCoLead ? " for the whole file." : " for this file and every co-client on it."}
                    </p>
                  </div>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Firm"
                  className="inline-flex rounded-xl border border-slate-300 bg-slate-50 p-1 self-start"
                >
                  {FIRM_KEYS.map((key) => {
                    const active = current === key;
                    return (
                      <button
                        key={key}
                        role="radio"
                        aria-checked={active}
                        onClick={() => saveFirm(key)}
                        disabled={savingFirm}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                          active
                            ? "bg-white text-brand-primary shadow-sm border border-slate-200"
                            : "text-slate-500 hover:text-slate-700"
                        }`}
                      >
                        {savingFirm && !active && <Loader2 size={12} className="animate-spin" />}
                        {FIRMS[key].label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="text-xs font-medium text-slate-500">
                Mail is sent from{" "}
                <span className="font-bold text-slate-700">{FIRMS[current].fromEmail}</span>.
              </p>
              {firmResult && (
                <div
                  className={`flex items-start gap-2 px-4 py-3 rounded-xl border text-sm font-semibold ${
                    firmResult.success
                      ? "bg-green-50 border-green-200 text-green-800"
                      : "bg-amber-50 border-amber-200 text-amber-800"
                  }`}
                >
                  {firmResult.success ? (
                    <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                  )}
                  <span>{firmResult.message}</span>
                </div>
              )}
            </div>
          );
        })()}

        {/* Convert Result Banner */}
        {convertResult && (
          <div
            className={`flex items-center gap-3 px-5 py-4 rounded-xl border text-sm font-semibold ${
              convertResult.success
                ? "bg-green-50 border-green-200 text-green-800"
                : "bg-red-50 border-red-200 text-red-700"
            }`}
          >
            {convertResult.success ? (
              <CheckCircle2 size={18} />
            ) : (
              <AlertTriangle size={18} />
            )}
            <div className="space-y-1">
              <p>{convertResult.title}</p>
              {convertResult.details.map((detail, index) => (
                <p key={index} className="text-xs font-medium">
                  {detail}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Edit Result Banner */}
        {editResult && (
          <div
            className={`flex items-center gap-3 px-5 py-4 rounded-xl border text-sm font-semibold ${
              editResult.success
                ? "bg-green-50 border-green-200 text-green-800"
                : "bg-red-50 border-red-200 text-red-700"
            }`}
          >
            {editResult.success ? (
              <CheckCircle2 size={18} />
            ) : (
              <AlertTriangle size={18} />
            )}
            {editResult.message}
          </div>
        )}

        {/* Welcome Email Result Banner */}
        {welcomeResult && (
          <div
            className={`flex items-center gap-3 px-5 py-4 rounded-xl border text-sm font-semibold ${
              welcomeResult.success
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : "bg-red-50 border-red-200 text-red-700"
            }`}
          >
            {welcomeResult.success ? (
              <Mail size={18} />
            ) : (
              <AlertTriangle size={18} />
            )}
            {welcomeResult.message}
          </div>
        )}


        {/* Sections */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Personal Info */}
          <SectionHeader
            title="Personal Information"
            id="personal"
            icon={UserIcon}
          />
          {expandedSections.includes("personal") && (
            <div className="p-8 space-y-6 animate-in slide-in-from-top-2 duration-300 border-t border-slate-50">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    First Name
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={isEditing ? editForm.firstName : (selectedLead.firstName ?? "")}
                    onChange={(e) => updateEditField("firstName", e.target.value)}
                    readOnly={!isEditing}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Last Name
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={isEditing ? editForm.lastName : (selectedLead.lastName ?? "")}
                    onChange={(e) => updateEditField("lastName", e.target.value)}
                    readOnly={!isEditing}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Phone Number
                  </label>
                  <div className="relative">
                    <Smartphone
                      size={16}
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
                    />
                    <input
                      type="text"
                      className="w-full pl-11 pr-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all"
                      value={isEditing ? editForm.phone : (selectedLead.phone ?? "")}
                      onChange={(e) => updateEditField("phone", e.target.value)}
                      readOnly={!isEditing}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail
                      size={16}
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
                    />
                    <input
                      type="email"
                      className="w-full pl-11 pr-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all"
                      value={isEditing ? editForm.email : (selectedLead.email ?? "")}
                      onChange={(e) => updateEditField("email", e.target.value)}
                      readOnly={!isEditing}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Address */}
          <SectionHeader
            title="Purchase Property Address"
            id="current-address"
            icon={MapPin}
          />
          {expandedSections.includes("current-address") && (
            <div className="p-8 space-y-6 animate-in slide-in-from-top-2 duration-300 border-t border-slate-50">
              {/* Street + unit share a row: intake captures a unit/suite for
                  condos and it has to be visible here, not just on the deal. */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-2 md:col-span-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Street Address
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={isEditing ? editForm.addressStreet : (selectedLead.addressStreet ?? "")}
                    onChange={(e) => updateEditField("addressStreet", e.target.value)}
                    readOnly={!isEditing}
                    placeholder="e.g. 10 Milner Business Court"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Unit / Suite
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={isEditing ? (editForm.addressUnit ?? "") : (selectedLead.addressUnit ?? "")}
                    onChange={(e) => updateEditField("addressUnit", e.target.value)}
                    readOnly={!isEditing}
                    placeholder="e.g. 210"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    City
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={isEditing ? editForm.addressCity : (selectedLead.addressCity ?? "")}
                    onChange={(e) => updateEditField("addressCity", e.target.value)}
                    readOnly={!isEditing}
                    placeholder="e.g. Toronto"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Province
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={isEditing ? editForm.addressProvince : (selectedLead.addressProvince ?? "")}
                    onChange={(e) => updateEditField("addressProvince", e.target.value)}
                    readOnly={!isEditing}
                    placeholder="e.g. ON"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Postal Code
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={isEditing ? editForm.addressPostalCode : (selectedLead.addressPostalCode ?? "")}
                    onChange={(e) =>
                      updateEditField("addressPostalCode", formatPostalCode(e.target.value))
                    }
                    readOnly={!isEditing}
                    placeholder="e.g. M1B 3C6"
                  />
                </div>
              </div>
              {/* Transaction amounts for this property — the price
                  (leads.price) and the deposit already paid
                  (leads.deposit_amount), which the client gives at intake and
                  the closing-cost estimator prefills from. Formatted for
                  reading, raw for editing so the admin edits the digits. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    {isSaleOnly ? "Sale Price" : "Purchase Price"}
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={isEditing ? (editForm.price ?? "") : formatPriceDisplay(selectedLead.price)}
                    onChange={(e) => updateEditField("price", e.target.value)}
                    readOnly={!isEditing}
                    placeholder="e.g. 850000"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Deposit Amount
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    value={
                      isEditing
                        ? (editForm.depositAmount ?? "")
                        : formatPriceDisplay(selectedLead.depositAmount)
                    }
                    onChange={(e) => updateEditField("depositAmount", e.target.value)}
                    readOnly={!isEditing}
                    placeholder="e.g. 50000"
                  />
                </div>
                {/* Closing date given at intake. Optional — blank is normal for
                    a client who hasn't signed an agreement yet. Read-only here:
                    the authoritative date is set at conversion (this value
                    seeds that dialog) and edited on the deal thereafter. */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    {isSaleOnly ? "Sale Closing Date" : "Closing Date"}
                  </label>
                  <input
                    type="date"
                    className={inputClasses}
                    value={selectedLead.closingDate ?? ""}
                    readOnly
                    disabled={isEditing}
                  />
                  {!selectedLead.closingDate && (
                    <p className="text-xs text-slate-400">Not given at intake.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Selling Property Address (only for combined Purchase & Sale leads) */}
          {isPurchaseAndSale && (
            <>
              <SectionHeader
                title="Selling Property Address"
                id="selling-address"
                icon={MapPin}
              />
              {expandedSections.includes("selling-address") && (
                <div className="p-8 space-y-6 animate-in slide-in-from-top-2 duration-300 border-t border-slate-50">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Street Address
                      </label>
                      <input
                        type="text"
                        className={inputClasses}
                        value={isEditing ? editForm.sellingAddressStreet : (selectedLead.sellingAddressStreet ?? "")}
                        onChange={(e) => updateEditField("sellingAddressStreet", e.target.value)}
                        readOnly={!isEditing}
                        placeholder="e.g. 10 Milner Business Court"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Unit / Suite
                      </label>
                      <input
                        type="text"
                        className={inputClasses}
                        value={isEditing ? (editForm.sellingAddressUnit ?? "") : (selectedLead.sellingAddressUnit ?? "")}
                        onChange={(e) => updateEditField("sellingAddressUnit", e.target.value)}
                        readOnly={!isEditing}
                        placeholder="e.g. 210"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        City
                      </label>
                      <input
                        type="text"
                        className={inputClasses}
                        value={isEditing ? editForm.sellingAddressCity : (selectedLead.sellingAddressCity ?? "")}
                        onChange={(e) => updateEditField("sellingAddressCity", e.target.value)}
                        readOnly={!isEditing}
                        placeholder="e.g. Toronto"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Province
                      </label>
                      <input
                        type="text"
                        className={inputClasses}
                        value={isEditing ? editForm.sellingAddressProvince : (selectedLead.sellingAddressProvince ?? "")}
                        onChange={(e) => updateEditField("sellingAddressProvince", e.target.value)}
                        readOnly={!isEditing}
                        placeholder="e.g. ON"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Postal Code
                      </label>
                      <input
                        type="text"
                        className={inputClasses}
                        value={isEditing ? editForm.sellingAddressPostalCode : (selectedLead.sellingAddressPostalCode ?? "")}
                        onChange={(e) =>
                          updateEditField(
                            "sellingAddressPostalCode",
                            formatPostalCode(e.target.value),
                          )
                        }
                        readOnly={!isEditing}
                        placeholder="e.g. M1B 3C6"
                      />
                    </div>
                  </div>
                  {/* Sale side amounts (leads.selling_price /
                      leads.selling_deposit_amount) — only combined Purchase &
                      Sale files carry them, which is why they live in this
                      section rather than alongside the purchase figures. */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Sale Price
                      </label>
                      <input
                        type="text"
                        className={inputClasses}
                        value={isEditing ? (editForm.sellingPrice ?? "") : formatPriceDisplay(selectedLead.sellingPrice)}
                        onChange={(e) => updateEditField("sellingPrice", e.target.value)}
                        readOnly={!isEditing}
                        placeholder="e.g. 720000"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Deposit Amount
                      </label>
                      <input
                        type="text"
                        className={inputClasses}
                        value={
                          isEditing
                            ? (editForm.sellingDepositAmount ?? "")
                            : formatPriceDisplay(selectedLead.sellingDepositAmount)
                        }
                        onChange={(e) =>
                          updateEditField("sellingDepositAmount", e.target.value)
                        }
                        readOnly={!isEditing}
                        placeholder="e.g. 25000"
                      />
                    </div>
                    {/* Sale-side closing date. A Buy & Sell client gives two —
                        this is the one for the property they're selling. */}
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Sale Closing Date
                      </label>
                      <input
                        type="date"
                        className={inputClasses}
                        value={selectedLead.sellingClosingDate ?? ""}
                        readOnly
                        disabled={isEditing}
                      />
                      {!selectedLead.sellingClosingDate && (
                        <p className="text-xs text-slate-400">Not given at intake.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {(() => {
            const rp = selectedLead.referralPartner ?? null;
            const partnerName = rp?.agent_name || selectedLead.referralAgentName || null;
            const partnerCompany = rp?.brokerage_name || selectedLead.referralAgentCompany || null;
            const partnerEmail = rp?.agent_email || selectedLead.referralAgentEmail || null;
            const partnerPhone = rp?.agent_phone || null;
            const partnerType = rp?.brokerage_type || null;
            const referralCode = rp?.referral_code || null;
            const hasPartner = !!(partnerName || partnerCompany || partnerEmail);

            // The section always renders now, empty or not: an admin who didn't
            // know the agent at intake needs somewhere to add one later, and
            // hiding the section left no entry point at all.

            // The "your client signed up" email is a one-shot fired on account
            // activation. An agent linked after that missed it, so offer a
            // manual send. Only meaningful for a linked partner with an email —
            // the free-text intake fields aren't actionable here.
            const canNotify =
              !!rp?.agent_email && !selectedLead.agentSignupEmailSent;

            const typeLabel = partnerType
              ? partnerType.toLowerCase().includes("agent")
                ? "Agent"
                : partnerType.toLowerCase().includes("broker")
                  ? "Broker"
                  : partnerType
              : null;

            const dash = <span className="text-slate-300 italic">—</span>;

            return (
              <>
                {/* Partner Details — the referral partner for this lead
                    (resolved from partner_id, or a manually-named agent captured
                    at intake). Family co-leads are still listed higher up. */}
                <SectionHeader
                  title="Partner Details"
                  id="client-leads"
                  icon={BriefcaseIcon}
                />
                {expandedSections.includes("client-leads") && (
                  <div className="p-0 animate-in slide-in-from-top-2 duration-300 border-t border-slate-50">
                    {agentResult && (
                      <div
                        className={`flex items-start gap-2 px-6 py-3 text-sm font-medium border-b ${
                          agentResult.success
                            ? "bg-green-50 border-green-100 text-green-800"
                            : "bg-red-50 border-red-100 text-red-700"
                        }`}
                      >
                        {agentResult.success ? (
                          <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                        ) : (
                          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                        )}
                        <span>{agentResult.message}</span>
                      </div>
                    )}

                    {!hasPartner ? (
                      <div className="px-6 py-8 text-center">
                        <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
                          <BriefcaseIcon size={18} />
                        </div>
                        <p className="text-sm font-bold text-slate-700">
                          No agent linked to this file
                        </p>
                        <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                          Add the referring agent or broker once you know who
                          they are. They&apos;ll be copied on client emails that
                          are shared with agents, and the file will count towards
                          their referrals.
                        </p>
                      </div>
                    ) : (
                    <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="bg-slate-50/50 border-b border-slate-200 text-[11px] font-black text-slate-400 uppercase tracking-widest">
                          <th className="px-6 py-3">Name</th>
                          <th className="px-6 py-3">Company</th>
                          <th className="px-6 py-3">Email</th>
                          <th className="px-6 py-3">Phone</th>
                          <th className="px-6 py-3">Type</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        <tr className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-brand-light flex items-center justify-center text-brand-primary">
                                <UserPlus size={16} />
                              </div>
                              <span className="font-bold text-slate-900 text-sm">
                                {partnerName || "—"}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">{partnerCompany || dash}</td>
                          <td className="px-6 py-4 text-sm">
                            {partnerEmail ? (
                              <a
                                href={`mailto:${partnerEmail}`}
                                className="text-brand-primary font-semibold hover:underline"
                              >
                                {partnerEmail}
                              </a>
                            ) : (
                              dash
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">{partnerPhone || dash}</td>
                          <td className="px-6 py-4">
                            {typeLabel ? (
                              <span
                                className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-tight border ${
                                  typeLabel === "Agent"
                                    ? "bg-blue-100 text-blue-700 border-blue-200"
                                    : typeLabel === "Broker"
                                      ? "bg-amber-100 text-amber-700 border-amber-200"
                                      : "bg-slate-100 text-slate-600 border-slate-200"
                                }`}
                              >
                                {typeLabel}
                              </span>
                            ) : (
                              dash
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    {referralCode && (
                      <div className="px-6 py-3 border-t border-slate-50 text-xs text-slate-500 bg-slate-50/20">
                        Referral code:{" "}
                        <span className="font-bold text-slate-700 uppercase tracking-wide">{referralCode}</span>
                      </div>
                    )}
                    </div>
                    )}

                    {/* Actions — the post-intake entry point for attaching an
                        agent. Everything here applies file-wide (see saveAgent). */}
                    <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/40 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={openAgentModal}
                        disabled={savingAgent || notifyingAgent}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-primary text-white text-xs font-bold hover:opacity-90 transition disabled:opacity-50"
                      >
                        {hasPartner ? <Edit3 size={13} /> : <UserPlus size={13} />}
                        {hasPartner ? "Change Agent" : "Add Agent"}
                      </button>

                      {hasPartner && canNotify && (
                        <button
                          type="button"
                          onClick={notifyAgent}
                          disabled={savingAgent || notifyingAgent}
                          title="Send the agent the one-off “your client signed up” email. Only needed when the agent was linked after the client activated their account."
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-bold hover:bg-slate-50 transition disabled:opacity-50"
                        >
                          {notifyingAgent ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Send size={13} />
                          )}
                          Notify Agent
                        </button>
                      )}

                      {hasPartner && (
                        <button
                          type="button"
                          onClick={removeAgent}
                          disabled={savingAgent || notifyingAgent}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-200 bg-white text-red-600 text-xs font-bold hover:bg-red-50 transition disabled:opacity-50"
                        >
                          <Trash2 size={13} />
                          Remove
                        </button>
                      )}

                      <span className="ml-auto text-[11px] text-slate-400">
                        Applies to everyone on this file.
                      </span>
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          {/* ── Agreement of Purchase and Sale ─────────────────────────────
              The agreement on this file, from wherever it was uploaded: the
              intake form, the APS task in the client portal, or a staff upload.
              All three land in one of two different stores, which is why this
              comes from its own route rather than a table read — see
              leadApsDocuments.ts. Read-only, and read-only on purpose: this
              section exists so the file can be looked at BEFORE conversion,
              which is when the first client call happens. Uploading and
              removing still belong to the deal page, which owns the
              task-completion side effects. */}
          {(() => {
            const rootLeadId = selectedLead.parentLeadId ?? selectedLead.id;

            return (
              <>
                <SectionHeader
                  title="Agreement of Purchase and Sale"
                  id="documents"
                  icon={Paperclip}
                  count={apsDocs.length}
                />
                {expandedSections.includes("documents") && (
                  <div className="animate-in slide-in-from-top-2 duration-300 border-t border-slate-50">
                    {apsDocsLoading ? (
                      <div className="flex items-center gap-2 px-6 py-6 text-sm font-medium text-slate-500">
                        <Loader2 size={16} className="animate-spin" />
                        Loading…
                      </div>
                    ) : apsDocsError ? (
                      <div className="flex items-start gap-2 mx-6 my-5 px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                        <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                        <span>{apsDocsError}</span>
                      </div>
                    ) : apsDocs.length === 0 ? (
                      <div className="px-6 py-8 text-center">
                        <FileText size={28} className="mx-auto text-slate-300" />
                        <p className="mt-2 text-sm font-bold text-slate-500">
                          No agreement on this file yet
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          It appears here as soon as the client attaches one — at
                          intake or against the agreement task.
                        </p>
                      </div>
                    ) : (
                      <ul className="px-6 py-4 space-y-2">
                        {apsDocs.map((doc) => {
                          // Only name the owner when it is NOT the person being
                          // viewed — on a single-client file that would just
                          // repeat the page heading.
                          const ownerName =
                            !doc.leadId || doc.leadId === selectedLead.id
                              ? null
                              : getLeadDisplayName(doc.leadId);
                          const isRoot = doc.leadId === rootLeadId;
                          return (
                            <li
                              key={doc.fileUrl}
                              className="flex items-center justify-between gap-3 p-3 rounded-lg bg-slate-50 border border-slate-100"
                            >
                              <div className="flex items-start gap-3 min-w-0">
                                <FileText
                                  size={16}
                                  className="text-slate-400 flex-shrink-0 mt-0.5"
                                />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <p className="text-sm font-bold text-slate-800 truncate">
                                      {doc.fileName || "Untitled file"}
                                    </p>
                                    {doc.label && (
                                      <span
                                        className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-black border ${
                                          doc.label === "Sale"
                                            ? "bg-orange-100 text-orange-700 border-orange-200"
                                            : "bg-blue-100 text-blue-700 border-blue-200"
                                        }`}
                                      >
                                        {doc.label}
                                      </span>
                                    )}
                                  </div>
                                  {ownerName && (
                                    <p className="text-xs text-slate-400 mt-0.5">
                                      Uploaded under {ownerName}
                                      {isRoot ? " (primary)" : ""}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <a
                                  href={docDownloadHref(doc.fileUrl)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    void viewApsDoc(doc);
                                  }}
                                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:text-brand-primary hover:bg-white transition-colors"
                                  title="View"
                                  aria-label={`View ${doc.fileName || "file"}`}
                                >
                                  <Eye size={16} />
                                </a>
                                <button
                                  type="button"
                                  onClick={() => void downloadApsDoc(doc)}
                                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:text-brand-primary hover:bg-white transition-colors"
                                  title="Download"
                                  aria-label={`Download ${doc.fileName || "file"}`}
                                >
                                  <Download size={16} />
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </div>

        {/* ── Link Referral Agent Modal ── */}
        {agentModalOpen && createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto"
            onClick={() => !savingAgent && setAgentModalOpen(false)}
          >
            {(() => {
              const familyCount = getFamilyLeadIds(selectedLead).length;
              const q = partnerSearch.trim().toLowerCase();
              // Match on anything an admin might have to hand: the person, the
              // firm, their email, or the referral code from a business card.
              const visiblePartners = q
                ? partners.filter((p) =>
                    [p.agent_name, p.brokerage_name, p.agent_email, p.referral_code]
                      .some((v) => (v ?? "").toLowerCase().includes(q)),
                  )
                : partners;
              const currentPartnerId = selectedLead.referralPartner?.id ?? null;

              return (
                <div
                  className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden my-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Header */}
                  <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-slate-200">
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">
                        {currentPartnerId ? "Change Referral Agent" : "Add Referral Agent"}
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {familyCount > 1
                          ? `Applies to all ${familyCount} people on this file and their deals.`
                          : "Applies to this client and their deal."}
                      </p>
                    </div>
                    <button
                      onClick={() => !savingAgent && setAgentModalOpen(false)}
                      className="text-slate-400 hover:text-slate-600 text-xl font-bold leading-none"
                      aria-label="Close"
                    >
                      &times;
                    </button>
                  </div>

                  {/* Search */}
                  <div className="flex-shrink-0 px-6 py-3 border-b border-slate-100">
                    <div className="relative">
                      <Search
                        size={15}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                      />
                      <input
                        type="text"
                        value={partnerSearch}
                        onChange={(e) => setPartnerSearch(e.target.value)}
                        placeholder="Search by name, brokerage, email or code"
                        className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                      />
                    </div>
                  </div>

                  {/* Partner list */}
                  <div className="flex-1 overflow-y-auto px-3 py-2 min-h-[8rem]">
                    {partnersLoading ? (
                      <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
                        <Loader2 size={16} className="animate-spin" />
                        Loading partners…
                      </div>
                    ) : partnersError ? (
                      <div className="flex items-start gap-2 m-3 px-3 py-2.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                        <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                        <span>{partnersError}</span>
                      </div>
                    ) : visiblePartners.length === 0 ? (
                      <div className="px-4 py-10 text-center">
                        <p className="text-sm font-bold text-slate-700">
                          {partners.length === 0
                            ? "No partners yet"
                            : "No partners match that search"}
                        </p>
                        <p className="text-xs text-slate-500 mt-1">
                          Only agents in the Partners list can be linked. Add them
                          under Partners first, then come back here.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {visiblePartners.map((p) => {
                          const picked = pickedPartnerId === p.id;
                          const isCurrent = currentPartnerId === p.id;
                          return (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => setPickedPartnerId(p.id)}
                              className={`w-full text-left px-3 py-2.5 rounded-lg border transition ${
                                picked
                                  ? "border-brand-primary bg-brand-light/40"
                                  : "border-transparent hover:bg-slate-50"
                              }`}
                            >
                              <div className="flex items-start gap-3">
                                <div
                                  className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                                    picked
                                      ? "border-brand-primary"
                                      : "border-slate-300"
                                  }`}
                                >
                                  {picked && (
                                    <span className="w-2 h-2 rounded-full bg-brand-primary" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm font-bold text-slate-900">
                                      {p.agent_name || "Unnamed partner"}
                                    </span>
                                    {p.brokerage_type && (
                                      <span
                                        className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase border ${
                                          p.brokerage_type
                                            .toLowerCase()
                                            .includes("agent")
                                            ? "bg-blue-100 text-blue-700 border-blue-200"
                                            : "bg-amber-100 text-amber-700 border-amber-200"
                                        }`}
                                      >
                                        {p.brokerage_type}
                                      </span>
                                    )}
                                    {isCurrent && (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase border bg-green-100 text-green-700 border-green-200">
                                        Current
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-slate-500 truncate">
                                    {[p.brokerage_name, p.agent_email]
                                      .filter(Boolean)
                                      .join(" · ") || "No contact details"}
                                  </p>
                                  {p.referral_code && (
                                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-0.5">
                                      {p.referral_code}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Save failures land here — the modal stays open so the pick
                      isn't lost. Successes close it and report in the section. */}
                  {agentResult && !agentResult.success && (
                    <div className="flex-shrink-0 mx-6 mb-3 flex items-start gap-2 px-3 py-2.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                      <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                      <span>{agentResult.message}</span>
                    </div>
                  )}

                  {/* Footer */}
                  <div className="flex-shrink-0 flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-200 bg-slate-50/50">
                    <button
                      type="button"
                      onClick={() => setAgentModalOpen(false)}
                      disabled={savingAgent}
                      className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-bold hover:bg-slate-50 transition disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => pickedPartnerId && saveAgent(pickedPartnerId)}
                      disabled={
                        savingAgent ||
                        !pickedPartnerId ||
                        pickedPartnerId === currentPartnerId
                      }
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-bold hover:opacity-90 transition disabled:opacity-50"
                    >
                      {savingAgent && <Loader2 size={14} className="animate-spin" />}
                      {savingAgent ? "Saving…" : "Link Agent"}
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        , document.body)}

        {/* ── Convert to Deal Modal ── */}
        {convertModalOpen && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !converting && setConvertModalOpen(false)}>
            {(() => {
              const familyLeadIds = getFamilyLeadIds(selectedLead);
              const familyMembers = leads.filter((l) => familyLeadIds.includes(l.id));
              const hasFamily = familyMembers.length > 1;

              return (
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Convert to Deal</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {hasFamily
                      ? `Will create ${familyMembers.length} deals & send ${familyMembers.length} invite emails.`
                      : "Creates deal, milestones, tasks & sends invite email."}
                  </p>
                </div>
                <button onClick={() => !converting && setConvertModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">&times;</button>
              </div>

              {/* Lead summary */}
              <div className="px-6 py-4 bg-slate-50 border-b border-slate-200">
                {hasFamily ? (() => {
                  const primaryFm = familyMembers.find((fm) => !fm.parentLeadId) ?? selectedLead;
                  const lt = (selectedLead?.lead_type ?? "").toLowerCase().trim();
                  const headerLabel =
                    lt.includes("purchase") && lt.includes("sale")
                      ? "Primary & Co-Clients"
                      : lt === "sale"
                      ? "Seller & Co-Sellers"
                      : "Purchaser & Co-Purchasers";
                  return (
                  <>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                      {headerLabel} ({familyMembers.length})
                    </p>
                    <div className="space-y-2">
                      {[...familyMembers].sort((a, b) => (a.parentLeadId ? 1 : 0) - (b.parentLeadId ? 1 : 0)).map((fm) => {
                        const isPrimary = !fm.parentLeadId;
                        const role = isPrimary ? "Primary" : (getCoRole(fm, primaryFm) === "co-seller" ? "Co-Seller" : "Co-Purchaser");
                        const badgeClass = isPrimary
                          ? "bg-green-100 text-green-700 border-green-200"
                          : role === "Co-Seller"
                          ? "bg-amber-100 text-amber-700 border-amber-200"
                          : "bg-blue-100 text-blue-700 border-blue-200";
                        return (
                          <div key={fm.id} className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-bold text-slate-800">{fm.firstName} {fm.lastName}</p>
                              <p className="text-xs text-slate-500">{fm.email}</p>
                            </div>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${badgeClass}`}>{role}</span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                  );
                })() : (
                  <>
                    <p className="text-sm font-bold text-slate-800">{selectedLead.firstName} {selectedLead.lastName}</p>
                    <p className="text-xs text-slate-500">{selectedLead.email}</p>
                  </>
                )}
                {selectedLead.lead_type && (
                  <p className="text-xs text-slate-400 mt-1.5">Type: {selectedLead.lead_type}</p>
                )}
              </div>

              {/* Form */}
              <div className="px-6 py-4 space-y-4">
                {/* Inputs are hidden once the conversion succeeds — only the
                    result message + Close remain. Kept on failure so the admin
                    can fix the file number and retry. */}
                {!convertResult?.success && (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">
                        File Number <span className="text-slate-400 font-normal">(optional)</span>
                      </label>
                      <input
                        type="text"
                        value={convertFileNumber}
                        onChange={(e) => setConvertFileNumber(e.target.value)}
                        placeholder="e.g. 26P-0059"
                        disabled={converting}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                      />
                      <p className="text-xs text-slate-400 mt-1.5">
                        Leave blank to auto-generate. All parties in this file
                        (co-purchasers/co-sellers) share this number. If it's already
                        used by another file, conversion is blocked with an error.
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">
                        Closing Date <span className="text-slate-400 font-normal">(optional)</span>
                      </label>
                      <input
                        type="date"
                        value={convertClosingDate}
                        onChange={(e) => setConvertClosingDate(e.target.value)}
                        disabled={converting}
                        min={todayLocalStr}
                        max="2100-12-31"
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                      />
                    </div>
                  </>
                )}

                {convertResult && (
                  <div className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium ${
                    convertResult.success ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-700"
                  }`}>
                    {convertResult.success ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" /> : <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />}
                    <div className="space-y-1">
                      <p>{convertResult.title}</p>
                      {convertResult.details.map((detail, index) => (
                        <p key={index} className="text-xs font-medium">
                          {detail}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
                <button
                  onClick={() => setConvertModalOpen(false)}
                  disabled={converting}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors"
                >
                  {convertResult?.success ? "Close" : "Cancel"}
                </button>
                {!convertResult?.success && (
                  <button
                    onClick={handleConvertToDeal}
                    disabled={converting}
                    className="flex items-center gap-2 bg-brand-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-primary/90 transition-colors disabled:opacity-50"
                  >
                    {converting ? <><Loader2 size={14} className="animate-spin" /> Converting...</> : <><Zap size={14} /> Convert</>}
                  </button>
                )}
              </div>
            </div>
              ); })()}
          </div>
        , document.body)}

        {/* ── Send Email Template Picker Modal ── */}
        {emailModalOpen && createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto"
            onClick={() => !sendingWelcome && setEmailModalOpen(false)}
          >
            <div
              className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden my-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-slate-200">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Send Email</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {emailRecipients.length === 0
                      ? "No related clients have an email address."
                      : `${selectedRecipientIds.size} of ${emailRecipients.length} client${emailRecipients.length === 1 ? "" : "s"} selected`}
                  </p>
                </div>
                <button
                  onClick={() => !sendingWelcome && setEmailModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 text-xl font-bold leading-none"
                  aria-label="Close"
                >
                  &times;
                </button>
              </div>

              {/* Recipient picker — admin checks who should receive the email */}
              {emailRecipients.length > 0 && (
                <div className="flex-shrink-0 px-6 py-3 bg-slate-50 border-b border-slate-200 max-h-40 overflow-y-auto">
                  {emailRecipients.length > 1 && (
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                        Recipients
                      </p>
                      <div className="flex items-center gap-2 text-[10px] font-bold">
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedRecipientIds(
                              new Set(emailRecipients.map(({ lead }) => lead.id)),
                            )
                          }
                          className="text-brand-primary hover:underline uppercase tracking-tight"
                        >
                          Select all
                        </button>
                        <span className="text-slate-300">|</span>
                        <button
                          type="button"
                          onClick={() => setSelectedRecipientIds(new Set())}
                          className="text-slate-500 hover:underline uppercase tracking-tight"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  )}
                  <ul className="space-y-1">
                    {emailRecipients.map(({ lead: r, role }) => {
                      const checked = selectedRecipientIds.has(r.id);
                      const toggle = () => {
                        setSelectedRecipientIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(r.id)) next.delete(r.id);
                          else next.add(r.id);
                          return next;
                        });
                      };
                      return (
                        <li key={r.id}>
                          <label
                            className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                              checked ? "bg-white ring-1 ring-brand-primary/30" : "hover:bg-white"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={toggle}
                              disabled={sendingWelcome}
                              className="w-3.5 h-3.5 rounded border-slate-300 text-brand-primary focus:ring-brand-primary/40 cursor-pointer disabled:cursor-not-allowed"
                            />
                            <span className="font-semibold text-slate-700 truncate">
                              {r.firstName} {r.lastName}
                            </span>
                            <span className="text-slate-500 truncate">— {r.email}</span>
                            {isRetainerTemplateSelected && (() => {
                              const entry = retainerStatus[r.id];
                              const known = entry !== undefined;
                              const signed = entry?.signed === true;
                              const hasPdf = entry?.has_pdf === true;
                              // Three states the admin needs to distinguish:
                              //  - unknown/loading      → grey "Checking…"
                              //  - signed + has PDF     → green, send works
                              //  - signed but no PDF    → amber; signature is
                              //    in retainer_signatures but the async PDF
                              //    step in iclosed_web never persisted to
                              //    lead_corporate_docs, so nothing to attach
                              //  - not signed at all    → red
                              const state =
                                retainerStatusLoading && !known
                                  ? "loading"
                                  : signed && hasPdf
                                    ? "signed_pdf"
                                    : signed
                                      ? "signed_no_pdf"
                                      : "unsigned";
                              const label =
                                state === "loading"
                                  ? "Checking…"
                                  : state === "signed_pdf"
                                    ? "Retainer signed"
                                    : state === "signed_no_pdf"
                                      ? "Signed (no PDF)"
                                      : "Not signed";
                              const cls =
                                state === "loading"
                                  ? "bg-slate-100 text-slate-500 border-slate-200"
                                  : state === "signed_pdf"
                                    ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                                    : state === "signed_no_pdf"
                                      ? "bg-amber-100 text-amber-700 border-amber-200"
                                      : "bg-rose-100 text-rose-700 border-rose-200";
                              return (
                                <span
                                  className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-tight border whitespace-nowrap ${cls}`}
                                  title={
                                    state === "signed_no_pdf"
                                      ? "Client signed but the retainer PDF wasn't generated — email can't attach it. Re-trigger PDF generation."
                                      : undefined
                                  }
                                >
                                  {label}
                                </span>
                              );
                            })()}
                            <span
                              className={`${isRetainerTemplateSelected ? "" : "ml-auto "}px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-tight border whitespace-nowrap ${
                                role === "Primary"
                                  ? "bg-green-100 text-green-700 border-green-200"
                                  : role === "Co-Seller"
                                  ? "bg-amber-100 text-amber-700 border-amber-200"
                                  : "bg-blue-100 text-blue-700 border-blue-200"
                              }`}
                            >
                              {role}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* Template list — the only section that scrolls */}
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-2 [scrollbar-width:thin] [scrollbar-color:#cbd5e1_transparent]">
                {emailTemplates.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-8">No active templates found.</p>
                ) : (
                  emailTemplates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedTemplateId(t.id)}
                      className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                        selectedTemplateId === t.id
                          ? "border-brand-primary bg-brand-light ring-1 ring-brand-primary/20"
                          : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Mail size={14} className={selectedTemplateId === t.id ? "text-brand-primary" : "text-slate-400"} />
                        <span className="font-medium text-slate-800 text-sm">{t.name}</span>
                      </div>
                      {t.body && (
                        <p className="text-xs text-slate-400 mt-1 ml-[22px] line-clamp-2">
                          {t.body.substring(0, 100)}{(t.body.length ?? 0) > 100 ? "..." : ""}
                        </p>
                      )}
                    </button>
                  ))
                )}
              </div>

              {/* Footer */}
              <div className="flex-shrink-0 flex justify-end gap-3 px-6 py-4 border-t border-slate-200 bg-white">
                <button
                  onClick={() => setEmailModalOpen(false)}
                  disabled={sendingWelcome}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  onClick={() =>
                    selectedLead &&
                    sendEmailToFamily(
                      selectedTemplateId || undefined,
                      Array.from(selectedRecipientIds),
                    )
                  }
                  disabled={
                    sendingWelcome ||
                    !selectedTemplateId ||
                    emailRecipients.length === 0 ||
                    selectedRecipientIds.size === 0
                  }
                  className="flex items-center gap-2 bg-brand-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sendingWelcome ? (
                    <><Loader2 size={14} className="animate-spin" /> Sending...</>
                  ) : (
                    <>
                      <Send size={14} />{" "}
                      {selectedRecipientIds.size > 1
                        ? `Send to ${selectedRecipientIds.size} clients`
                        : "Send Email"}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        , document.body)}
      </div>
    );
  }

  // ── LIST VIEW ─────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500 py-4">
      {/* Firm-change feedback. The list has no detail banner to write into, and
          a firm change is invisible from the row alone once the select settles.

          Offset by --app-header-h, NOT a bare top-6: <main> is the scroll root
          and AppHeader is sticky at the top of it, so anything fixed within the
          first 56px of the viewport lands underneath the header and shows only
          its bottom sliver. The variable is published by ClientLayout for
          exactly this, and falls back to 0 on a page rendered without that
          shell — same rule the calculator's action bar follows. */}
      {firmToast && (
        <div
          style={{ top: "calc(var(--app-header-h, 0px) + 1.5rem)" }}
          className={`fixed right-6 z-[60] px-5 py-3 rounded-lg shadow-lg text-sm font-medium text-white ${
            firmToast.success ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {firmToast.message}
        </div>
      )}
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">
            Leads Dashboard
          </h1>
          <p className="text-slate-500 font-medium">
            Manage and onboard prospective client leads.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="text"
              placeholder="Search by name, email, phone, address, lead type, price, status…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-12 pr-6 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-medium outline-none focus:border-brand-primary transition-all w-full md:w-64"
            />
          </div>
          {/* <button
            onClick={() => setIsAddModalOpen(true)}
            className="flex items-center gap-2 px-6 py-2.5 bg-brand-primary text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-brand-primaryHover transition-all shadow-lg active:scale-95 whitespace-nowrap"
          >
            <Plus size={16} /> Add Client
          </button> */}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
        {leadsLoading ? (
          <div className="flex items-center justify-center py-20 gap-3 text-slate-400">
            <Loader2 size={20} className="animate-spin" />
            <span className="font-medium">Loading leads...</span>
          </div>
        ) : leadsError ? (
          <div className="flex items-center justify-center py-16 gap-3 text-red-500">
            <AlertTriangle size={20} />
            <span className="font-semibold">{leadsError}</span>
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <UserIcon size={32} className="mb-3 text-slate-200" />
            <p className="font-semibold">No leads found</p>
            <p className="text-sm mt-1">
              Leads from the intake form will appear here.
            </p>
          </div>
        ) : (
          <table className="w-full min-w-[1000px] text-left border-t border-slate-200">
            <thead>
              <tr className="bg-white text-slate-800 text-xs font-bold border-b border-slate-200">
                <th className="px-4 py-3 w-12">No.</th>
                <th className="px-4 py-3">Client Name</th>
                <th className="px-4 py-3">Address</th>
                <th className="px-4 py-3 w-24">Lead Type</th>
                <th className="px-4 py-3 w-28">Price</th>
                <th className="px-4 py-3 w-28">Status</th>
                <th className="px-4 py-3 w-32">Firm</th>
                <th className="px-4 py-3 w-24 text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeads.map((lead, index) => {
                const isEven = index % 2 === 0;
                const rowClass = isEven ? "bg-white" : "bg-slate-50/80";
                const lt = (lead.lead_type ?? "").toLowerCase();
                const isCombined = lt.includes("purchase") && lt.includes("sale");
                const purchaseAddrFull = [lead.addressStreet, lead.addressCity, lead.addressProvince, lead.addressPostalCode].filter(Boolean).join(", ");
                const sellingAddrFull = [lead.sellingAddressStreet, lead.sellingAddressCity, lead.sellingAddressProvince, lead.sellingAddressPostalCode].filter(Boolean).join(", ");
                return (
                <tr
                  key={lead.id}
                  onClick={() => openLead(lead)}
                  className={`${rowClass} hover:bg-brand-light/20 cursor-pointer transition-colors border-b border-slate-100 text-xs text-slate-700 whitespace-nowrap`}
                >
                  <td className="px-4 py-3">{index + 1}</td>
                  <td className="px-4 py-3">
                    <div>
                      <span className="font-medium">{lead.firstName} {lead.lastName}</span>
                      {lead.status !== "Converted" && lead.created_at && (Date.now() - new Date(lead.created_at).getTime()) < 24 * 60 * 60 * 1000 && (
                        <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-100 text-green-700 border border-green-200">New</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 max-w-xs" title={isCombined ? `Purchase: ${purchaseAddrFull || "—"}\nSale: ${sellingAddrFull || "—"}` : purchaseAddrFull}>
                    {isCombined ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[9px] font-black text-blue-600 uppercase tracking-widest w-14 flex-shrink-0">Purchase</span>
                          <span className="truncate text-slate-700">{lead.addressStreet || "—"}</span>
                        </div>
                        <div className="h-px bg-slate-100" />
                        <div className="flex items-baseline gap-2">
                          <span className="text-[9px] font-black text-orange-600 uppercase tracking-widest w-14 flex-shrink-0">Sale</span>
                          <span className="truncate text-slate-700">{lead.sellingAddressStreet || "—"}</span>
                        </div>
                      </div>
                    ) : (
                      <span className="truncate block">{lead.addressStreet || "—"}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {lead.lead_type ? (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                        lead.lead_type === "Purchase" ? "bg-blue-100 text-blue-700 border-blue-200"
                          : lead.lead_type === "Sale" ? "bg-orange-100 text-orange-700 border-orange-200"
                          : "bg-slate-900 text-white border-slate-900"
                      }`}>{lead.lead_type}</span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 font-medium">{lead.price || "—"}</td>
                  <td className="px-4 py-3">
                    {lead.status === "Converted" ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 border border-green-200 shadow-sm">
                        <span className="mr-1">✓</span> Converted
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-white text-green-600 border border-green-400">
                        Active
                      </span>
                    )}
                  </td>
                  {/* Firm — assignable straight from the list. It is a property
                      of the whole FILE: the PUT cascades it to every co-lead,
                      and only primary leads are listed here, so one change per
                      row covers the family. */}
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {(() => {
                      const currentFirm = resolveFirmKey(lead.firmKey);
                      const saving = firmSavingId === lead.id;
                      return (
                        <div className="relative inline-flex items-center">
                          <select
                            value={currentFirm}
                            // Locked while ANY row is saving: two overlapping
                            // cascades on one family would race each other.
                            disabled={firmSavingId !== null}
                            onChange={(e) => saveFirm(e.target.value as FirmKey, lead)}
                            aria-label={`Firm for ${lead.firstName ?? ""} ${lead.lastName ?? ""}`}
                            title="Sets the sending address, the email logo and the retainer wording for this file and every co-client on it"
                            className={`appearance-none pl-2 pr-6 py-1 rounded-md border text-[10px] font-bold cursor-pointer outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                              currentFirm === "iclosed"
                                ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                                : "bg-slate-100 text-slate-700 border-slate-200"
                            }`}
                          >
                            {FIRM_KEYS.map((key) => (
                              <option key={key} value={key}>
                                {FIRMS[key].label}
                              </option>
                            ))}
                          </select>
                          {saving ? (
                            <Loader2 size={11} className="absolute right-1.5 animate-spin text-slate-500" />
                          ) : (
                            <ChevronDown size={11} className="absolute right-1.5 pointer-events-none text-slate-400" />
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); openLeadForEdit(lead); }}
                        className="text-slate-400 hover:text-brand-primary transition-colors p-1"
                        title="Edit lead"
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteLead(lead.id, `${lead.firstName} ${lead.lastName}`); }}
                        className="text-slate-300 hover:text-red-500 transition-colors p-1"
                        title="Delete lead"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
              {filteredLeads.length === 0 && (
                <tr><td colSpan={8} className="px-6 py-12 text-center text-slate-500"><p>No leads found.</p></td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination footer */}
      <div className="pt-4 text-center">
        <p className="text-[10px] text-slate-300 font-bold uppercase tracking-widest">
          iClosed Lead Management Tool ©2025 · {filteredLeads.length} leads
        </p>
      </div>
    </div>
  );
};

export default Leads;
