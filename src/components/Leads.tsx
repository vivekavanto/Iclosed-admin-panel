"use client";

import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabaseClient";
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
  Link2,
  Trash2,
} from "lucide-react";

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
  price?: string;
  created_at?: string;
  service?: string;
  subService?: string;
  apsSigned?: boolean;
  referralSource?: string;
  sellingAddressStreet?: string;
  sellingAddressCity?: string;
  sellingAddressPostalCode?: string;
  sellingAddressProvince?: string;
  parentLeadId?: string | null;
}

const Leads: React.FC = () => {
  const [view, setView] = useState<"LIST" | "DETAIL">("LIST");
  const [selectedLead, setSelectedLead] = useState<LeadUser | null>(null);
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

  const [expandedSections, setExpandedSections] = useState<string[]>([
    "personal",
    "current-address",
    "selling-address",
    "property-personal",
  ]);

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
    created_at: l.created_at,
    service: l.service,
    subService: l.sub_service,
    apsSigned: l.aps_signed,
    referralSource: l.referral_source,
    sellingAddressStreet: l.selling_address_street,
    sellingAddressCity: l.selling_address_city,
    sellingAddressPostalCode: l.selling_address_postal_code,
    sellingAddressProvince: l.selling_address_province,
    parentLeadId: l.parent_lead_id ?? null,
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
    setView("DETAIL");
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
          const results = data.results as any[];
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
            .map((r) => getLeadDisplayName(r.lead_id));
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

  // ── Send Email with selected template ─────────────────────────────────────
  async function sendWelcomeEmail(leadId: string, templateId?: string) {
    if (!selectedLead || selectedLead.status !== "Converted") {
      setWelcomeResult({
        success: false,
        message: "Email can only be sent after the lead has been converted to a deal.",
      });
      return;
    }

    setSendingWelcome(true);
    setWelcomeResult(null);
    try {
      const payload: any = { lead_id: leadId };
      if (templateId) payload.template_id = templateId;

      const res = await fetch(`/api/admin/send-welcome-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        setWelcomeResult({
          success: true,
          message: `Email sent to ${selectedLead?.email ?? "client"} (template: ${data.template_used})`,
        });
        setEmailModalOpen(false);
      } else {
        setWelcomeResult({
          success: false,
          message: data.error ?? "Failed to send email.",
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
  }: {
    title: string;
    id: string;
    icon: any;
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
      </div>
      <ChevronDown
        size={20}
        className={`text-slate-400 transition-transform duration-300 ${expandedSections.includes(id) ? "rotate-180" : ""}`}
      />
    </button>
  );

  // Determine whether a co-lead is a co-purchaser or co-seller.
  //   1. Trust the co-lead's own lead_type when it specifies a single side.
  //   2. Otherwise (empty, or "Purchase & Sale" mirrored from the parent)
  //      use the co-lead's selling_address_street as a tiebreaker — only
  //      co-sellers carry a selling-side address.
  //   3. Last resort: parent's lead_type (only useful when parent is single-
  //      sided, e.g. a Sale-only primary). Default to co-purchaser.
  const getCoRole = (
    coLead: Pick<LeadUser, "lead_type" | "sellingAddressStreet">,
    parent?: Pick<LeadUser, "lead_type"> | null,
  ): "co-purchaser" | "co-seller" => {
    const ownLt = (coLead.lead_type ?? "").toLowerCase().trim();
    const ownHasPurchase = ownLt.includes("purchase");
    const ownHasSale = ownLt.includes("sale");
    if (ownHasSale && !ownHasPurchase) return "co-seller";
    if (ownHasPurchase && !ownHasSale) return "co-purchaser";
    if (coLead.sellingAddressStreet) return "co-seller";
    const parentLt = (parent?.lead_type ?? "").toLowerCase().trim();
    if (parentLt === "sale") return "co-seller";
    return "co-purchaser";
  };

  const filteredLeads = leads
    .filter((l) => !l.parentLeadId) // Only show primary/standalone leads; co-purchasers/co-sellers visible in detail view
    .filter((l) => {
      const q = search.toLowerCase();
      return (
        l.firstName.toLowerCase().includes(q) ||
        l.lastName.toLowerCase().includes(q) ||
        l.email.toLowerCase().includes(q) ||
        (l.addressStreet ?? "").toLowerCase().includes(q) ||
        (l.addressCity ?? "").toLowerCase().includes(q) ||
        (l.lead_type ?? "").toLowerCase().includes(q) ||
        (l.price ?? "").toLowerCase().includes(q)
      );
    });

  const isConverted = selectedLead?.status === "Converted";
  const isPurchaseAndSale = (() => {
    const lt = (selectedLead?.lead_type ?? "").toLowerCase();
    return lt.includes("purchase") && lt.includes("sale");
  })();

  // ── DETAIL VIEW ───────────────────────────────────────────────────────────
  if (view === "DETAIL" && selectedLead) {
    return (
      <div key={selectedLead.id} className="max-w-6xl mx-auto space-y-4 sm:space-y-6 animate-in slide-in-from-right duration-300 py-2 sm:py-4 pb-20">
        {/* Back button */}
        <button
          onClick={() => setView("LIST")}
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
                    defaultValue={selectedLead.firstName}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Last Name
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    defaultValue={selectedLead.lastName}
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
                      defaultValue={selectedLead.phone}
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
                      defaultValue={selectedLead.email}
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
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                  Street Address
                </label>
                <input
                  type="text"
                  className={inputClasses}
                  defaultValue={selectedLead.addressStreet}
                  placeholder="e.g. 10 Milner Business Court"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    City
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    defaultValue={selectedLead.addressCity}
                    placeholder="e.g. Toronto"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Postal Code
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    defaultValue={selectedLead.addressPostalCode}
                    placeholder="e.g. M1B 3C6"
                  />
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
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                      Street Address
                    </label>
                    <input
                      type="text"
                      className={inputClasses}
                      defaultValue={selectedLead.sellingAddressStreet}
                      placeholder="e.g. 10 Milner Business Court"
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        City
                      </label>
                      <input
                        type="text"
                        className={inputClasses}
                        defaultValue={selectedLead.sellingAddressCity}
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
                        defaultValue={selectedLead.sellingAddressProvince}
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
                        defaultValue={selectedLead.sellingAddressPostalCode}
                        placeholder="e.g. M1B 3C6"
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Associated deals */}
          <SectionHeader
            title="Associated Client Leads"
            id="client-leads"
            icon={BriefcaseIcon}
          />
          {expandedSections.includes("client-leads") && (() => {
            // Find associated leads: parent + siblings + children
            const associatedLeads: { lead: LeadUser; role: string }[] = [];

            const formatRole = (role: "co-purchaser" | "co-seller") =>
              role === "co-seller" ? "Co-Seller" : "Co-Purchaser";

            const primaryLabelFor = (lead: LeadUser): string => {
              const lt = (lead.lead_type ?? "").toLowerCase().trim();
              // For combined "Purchase & Sale" we show a generic label since the
              // primary is both a purchaser and a seller.
              if (lt.includes("purchase") && lt.includes("sale")) return "Primary Client";
              if (lt === "sale") return "Primary Seller";
              return "Primary Purchaser";
            };

            if (selectedLead.parentLeadId) {
              // This is a co-purchaser/co-seller — show the primary
              const parent = leads.find((l) => l.id === selectedLead.parentLeadId) ?? null;
              if (parent) {
                associatedLeads.push({ lead: parent, role: primaryLabelFor(parent) });
              }
              // Also show siblings, each labeled by their own role
              leads
                .filter((l) => l.parentLeadId === selectedLead.parentLeadId && l.id !== selectedLead.id)
                .forEach((l) =>
                  associatedLeads.push({ lead: l, role: formatRole(getCoRole(l, parent)) }),
                );
            } else {
              // This is a primary — show all co-leads, each labeled by their own role
              leads
                .filter((l) => l.parentLeadId === selectedLead.id)
                .forEach((l) =>
                  associatedLeads.push({ lead: l, role: formatRole(getCoRole(l, selectedLead)) }),
                );
            }

            return (
              <div className="p-0 animate-in slide-in-from-top-2 duration-300 overflow-x-auto border-t border-slate-50">
                {associatedLeads.length === 0 ? (
                  <div className="p-12 text-center text-slate-400 font-medium italic text-sm bg-slate-50/20">
                    No associated leads for this client.
                  </div>
                ) : (
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-slate-50/50 border-b border-slate-200 text-[11px] font-black text-slate-400 uppercase tracking-widest">
                        <th className="px-6 py-3">Name</th>
                        <th className="px-6 py-3">Email</th>
                        <th className="px-6 py-3">Phone</th>
                        <th className="px-6 py-3">Role</th>
                        <th className="px-6 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {associatedLeads.map(({ lead: al, role }) => (
                        <tr
                          key={al.id}
                          onClick={() => openLead(al)}
                          className="hover:bg-slate-50/50 transition-colors cursor-pointer group"
                        >
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-brand-light flex items-center justify-center text-brand-primary group-hover:bg-brand-primary group-hover:text-white transition-colors">
                                <UserIcon size={16} />
                              </div>
                              <span className="font-bold text-slate-900 text-sm group-hover:text-brand-primary">
                                {al.firstName} {al.lastName}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">{al.email}</td>
                          <td className="px-6 py-4 text-sm text-slate-600">{al.phone}</td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-tight border ${
                              role.startsWith("Primary")
                                ? "bg-green-100 text-green-700 border-green-200"
                                : role === "Co-Seller"
                                ? "bg-amber-100 text-amber-700 border-amber-200"
                                : "bg-blue-100 text-blue-700 border-blue-200"
                            }`}>
                              {role}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            {al.status === "Converted" ? (
                              <span className="flex items-center gap-1 text-green-700 font-bold text-xs bg-green-50 px-2 py-0.5 rounded-full border border-green-100 w-fit">
                                <CheckCircle2 size={12} /> Converted
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-emerald-600 font-bold text-xs bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100 w-fit">
                                Active Lead
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })()}
        </div>

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
                    min="1900-01-01"
                    max="2100-12-31"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                  />
                </div>

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
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !sendingWelcome && setEmailModalOpen(false)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Send Email</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Send to <span className="font-semibold text-slate-700">{selectedLead?.email}</span>
                  </p>
                </div>
                <button onClick={() => !sendingWelcome && setEmailModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">&times;</button>
              </div>

              {/* Template list */}
              <div className="px-6 py-4 space-y-2 overflow-y-auto flex-1">
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
              <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
                <button
                  onClick={() => setEmailModalOpen(false)}
                  disabled={sendingWelcome}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => selectedLead && sendWelcomeEmail(selectedLead.id, selectedTemplateId || undefined)}
                  disabled={sendingWelcome || !selectedTemplateId}
                  className="flex items-center gap-2 bg-brand-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-primary/90 transition-colors disabled:opacity-50"
                >
                  {sendingWelcome ? <><Loader2 size={14} className="animate-spin" /> Sending...</> : <><Send size={14} /> Send Email</>}
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
              placeholder="Search leads..."
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
          <table className="w-full min-w-[900px] text-left border-t border-slate-200">
            <thead>
              <tr className="bg-white text-slate-800 text-xs font-bold border-b border-slate-200">
                <th className="px-4 py-3 w-12">No.</th>
                <th className="px-4 py-3">Client Name</th>
                <th className="px-4 py-3">Address</th>
                <th className="px-4 py-3 w-24">Lead Type</th>
                <th className="px-4 py-3 w-28">Price</th>
                <th className="px-4 py-3 w-28">Status</th>
                <th className="px-4 py-3 w-16 text-center">Action</th>
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
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteLead(lead.id, `${lead.firstName} ${lead.lastName}`); }}
                      className="text-slate-300 hover:text-red-500 transition-colors p-1"
                      title="Delete lead"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
                );
              })}
              {filteredLeads.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-500"><p>No leads found.</p></td></tr>
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
