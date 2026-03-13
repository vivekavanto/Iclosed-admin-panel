"use client";

import React, { useState, useEffect } from "react";
import {
  History,
  Mail,
  Key,
  User as UserIcon,
  Building2,
  Check,
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
  addressCity?: string;
  addressPostalCode?: string;
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
    message: string;
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
    "property-personal",
  ]);

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
          const mapped: LeadUser[] = (data.leads ?? []).map((l: any) => ({
            id: l.id,
            firstName: l.first_name ?? "",
            lastName: l.last_name ?? "",
            email: l.email ?? "",
            phone: l.phone ?? "",
            isCorporate: l.is_corporate ?? false,
            corporateName: l.corporate_name,
            incNumber: l.inc_number,
            addressStreet: l.address_street,
            addressCity: l.address_city,
            addressPostalCode: l.address_postal_code,
            status: l.status ?? "New",
            lead_type: l.lead_type,
            price: l.price,
            created_at: l.created_at,
          }));
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

  const handleAddClient = (e: React.FormEvent) => {
    e.preventDefault();
    setIsAddModalOpen(false);
  };

  const openLead = (lead: LeadUser) => {
    setSelectedLead(lead);
    setConvertResult(null);
    setView("DETAIL");
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  // ── Convert to Deal ────────────────────────────────────────────────────────
  async function handleConvertToDeal() {
    if (!selectedLead) return;
    setConverting(true);
    setConvertResult(null);
    try {
      const res = await fetch(`/api/admin/convert-lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: selectedLead.id,
          file_number: convertFileNumber.trim() || undefined,
          closing_date: convertClosingDate || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setConvertResult({
          success: true,
          message: `✅ Deal ${data.file_number} created! ${data.invite_sent ? `Invite email sent to ${selectedLead.email}.` : "Please manually create their login."}`,
        });
        // Update the lead status in local state
        setLeads((prev) =>
          prev.map((l) =>
            l.id === selectedLead.id ? { ...l, status: "Converted" } : l,
          ),
        );
        setSelectedLead((prev) =>
          prev ? { ...prev, status: "Converted" } : null,
        );
      } else {
        setConvertResult({
          success: false,
          message: data.error ?? "Conversion failed.",
        });
      }
    } catch (err) {
      setConvertResult({
        success: false,
        message: "Network error. Please try again.",
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

  const filteredLeads = leads.filter((l) => {
    const q = search.toLowerCase();
    return (
      l.firstName.toLowerCase().includes(q) ||
      l.lastName.toLowerCase().includes(q) ||
      l.email.toLowerCase().includes(q) ||
      (l.addressCity ?? "").toLowerCase().includes(q)
    );
  });

  const isConverted = selectedLead?.status === "Converted";

  // ── DETAIL VIEW ───────────────────────────────────────────────────────────
  if (view === "DETAIL" && selectedLead) {
    return (
      <div className="max-w-6xl mx-auto space-y-6 animate-in slide-in-from-right duration-300 py-4 pb-20">
        {/* Back button */}
        <button
          onClick={() => setView("LIST")}
          className="flex items-center gap-2 text-slate-500 font-bold text-sm hover:text-brand-primary transition-colors"
        >
          <ArrowLeft size={18} /> Back to Leads Dashboard
        </button>

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
                fetchEmailTemplates();
                setSelectedTemplateId("");
                setEmailModalOpen(true);
              }}
              disabled={sendingWelcome}
              className="flex items-center gap-2 px-6 py-2.5 bg-emerald-600 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-emerald-700 transition-all shadow-lg active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Send size={14} /> Send Email
            </button>
            <button className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg active:scale-95">
              <History size={14} /> View History
            </button>
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
            {convertResult.message}
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
            title="Current Address"
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

          {/* Associated deals */}
          <SectionHeader
            title="Associated Client Leads"
            id="client-leads"
            icon={BriefcaseIcon}
          />
          {expandedSections.includes("client-leads") && (
            <div className="p-0 animate-in slide-in-from-top-2 duration-300 overflow-x-auto border-t border-slate-50">
              <div className="p-12 text-center text-slate-400 font-medium italic text-sm bg-slate-50/20">
                No linked transaction files for this lead yet.
              </div>
            </div>
          )}
        </div>

        {/* ── Convert to Deal Modal ── */}
        {convertModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 animate-in fade-in duration-200">
            <div
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              onClick={() => !converting && setConvertModalOpen(false)}
            />
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md relative z-10 overflow-hidden animate-in zoom-in duration-200">
              {/* Header */}
              <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-start">
                <div>
                  <h3 className="text-xl font-black text-slate-900">
                    Convert to Deal
                  </h3>
                  <p className="text-slate-500 text-sm font-medium mt-1">
                    Creates deal, milestones, tasks & sends client invite email.
                  </p>
                </div>
                <button
                  onClick={() => !converting && setConvertModalOpen(false)}
                  className="text-slate-300 hover:text-slate-600 transition-colors mt-1"
                >
                  <X size={22} />
                </button>
              </div>

              {/* Lead summary */}
              <div className="px-8 py-5 bg-slate-50 border-b border-slate-100">
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-2">
                  Lead
                </p>
                <p className="font-bold text-slate-900">
                  {selectedLead.firstName} {selectedLead.lastName}
                </p>
                <p className="text-sm text-slate-500">{selectedLead.email}</p>
                {selectedLead.lead_type && (
                  <p className="text-xs text-slate-400 mt-1">
                    Type: {selectedLead.lead_type}
                  </p>
                )}
              </div>

              {/* Form */}
              <div className="px-8 py-6 space-y-5">
                <div className="space-y-2">
                  <label className="text-xs font-black text-slate-500 uppercase tracking-widest">
                    File Number{" "}
                    <span className="text-slate-300 font-normal normal-case">
                      (optional — auto-generated if blank)
                    </span>
                  </label>
                  <input
                    type="text"
                    value={convertFileNumber}
                    onChange={(e) => setConvertFileNumber(e.target.value)}
                    placeholder="e.g. 26P-0059"
                    disabled={converting}
                    className={inputClasses}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-black text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                    <CalendarDays size={12} /> Closing Date{" "}
                    <span className="text-slate-300 font-normal normal-case">
                      (optional)
                    </span>
                  </label>
                  <input
                    type="date"
                    value={convertClosingDate}
                    onChange={(e) => setConvertClosingDate(e.target.value)}
                    disabled={converting}
                    className={inputClasses}
                  />
                </div>

                {/* Result message */}
                {convertResult && (
                  <div
                    className={`flex items-start gap-2.5 px-4 py-3 rounded-xl border text-sm font-semibold ${
                      convertResult.success
                        ? "bg-green-50 border-green-200 text-green-800"
                        : "bg-red-50 border-red-200 text-red-700"
                    }`}
                  >
                    {convertResult.success ? (
                      <CheckCircle2
                        size={16}
                        className="flex-shrink-0 mt-0.5"
                      />
                    ) : (
                      <AlertTriangle
                        size={16}
                        className="flex-shrink-0 mt-0.5"
                      />
                    )}
                    <span>{convertResult.message}</span>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-8 pb-8 flex flex-col gap-3">
                {!convertResult?.success && (
                  <button
                    onClick={handleConvertToDeal}
                    disabled={converting}
                    className="w-full py-4 bg-brand-primary text-white rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {converting ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />{" "}
                        Converting...
                      </>
                    ) : (
                      <>
                        <Zap size={16} /> Confirm — Convert to Deal
                      </>
                    )}
                  </button>
                )}
                <button
                  onClick={() => setConvertModalOpen(false)}
                  disabled={converting}
                  className="w-full py-3 border border-slate-200 text-slate-600 rounded-2xl font-bold text-sm hover:bg-slate-50 transition-all"
                >
                  {convertResult?.success ? "Close" : "Cancel"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Send Email Template Picker Modal ── */}
        {emailModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 animate-in fade-in duration-200">
            <div
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              onClick={() => !sendingWelcome && setEmailModalOpen(false)}
            />
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md relative z-10 overflow-hidden animate-in zoom-in duration-200">
              {/* Header */}
              <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-start">
                <div>
                  <h3 className="text-xl font-black text-slate-900">
                    Send Email
                  </h3>
                  <p className="text-slate-500 text-sm font-medium mt-1">
                    Pick a template to send to{" "}
                    <span className="font-bold text-slate-700">
                      {selectedLead?.email}
                    </span>
                  </p>
                </div>
                <button
                  onClick={() => !sendingWelcome && setEmailModalOpen(false)}
                  className="text-slate-300 hover:text-slate-600 transition-colors mt-1"
                >
                  <X size={22} />
                </button>
              </div>

              {/* Template list */}
              <div className="px-8 py-6 space-y-3 max-h-80 overflow-y-auto">
                {emailTemplates.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-6">
                    No active templates with content found. Create one in Email
                    Templates first.
                  </p>
                ) : (
                  emailTemplates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedTemplateId(t.id)}
                      className={`w-full text-left px-5 py-4 rounded-xl border transition-all ${
                        selectedTemplateId === t.id
                          ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/20"
                          : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Mail
                          size={18}
                          className={
                            selectedTemplateId === t.id
                              ? "text-emerald-600"
                              : "text-slate-400"
                          }
                        />
                        <span className="font-bold text-slate-800 text-sm">
                          {t.name}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1.5 ml-[30px] line-clamp-2">
                        {t.body?.substring(0, 100)}
                        {(t.body?.length ?? 0) > 100 ? "..." : ""}
                      </p>
                    </button>
                  ))
                )}
              </div>

              {/* Footer */}
              <div className="px-8 pb-8 flex flex-col gap-3">
                <button
                  onClick={() =>
                    selectedLead &&
                    sendWelcomeEmail(selectedLead.id, selectedTemplateId || undefined)
                  }
                  disabled={sendingWelcome || !selectedTemplateId}
                  className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-emerald-600/20 hover:bg-emerald-700 transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {sendingWelcome ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Sending...
                    </>
                  ) : (
                    <>
                      <Send size={16} /> Send Email
                    </>
                  )}
                </button>
                <button
                  onClick={() => setEmailModalOpen(false)}
                  disabled={sendingWelcome}
                  className="w-full py-3 border border-slate-200 text-slate-600 rounded-2xl font-bold text-sm hover:bg-slate-50 transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
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
          <button
            onClick={() => setIsAddModalOpen(true)}
            className="flex items-center gap-2 px-6 py-2.5 bg-brand-primary text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-brand-primaryHover transition-all shadow-lg active:scale-95 whitespace-nowrap"
          >
            <Plus size={16} /> Add Client
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
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
          <table className="w-full text-left">
            <thead>
              <tr className="bg-slate-50/50 border-b border-slate-200 text-[11px] font-black text-slate-400 uppercase tracking-widest">
                <th className="px-8 py-5">Client Name</th>
                <th className="px-6 py-5">Contact Details</th>
                <th className="px-6 py-5">Type</th>
                <th className="px-6 py-5">Status</th>
                <th className="px-6 py-5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filteredLeads.map((lead) => (
                <tr
                  key={lead.id}
                  onClick={() => openLead(lead)}
                  className="hover:bg-slate-50/50 transition-colors cursor-pointer group"
                >
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-brand-light flex items-center justify-center text-brand-primary transition-colors group-hover:bg-brand-primary group-hover:text-white">
                        {lead.isCorporate ? (
                          <Building2 size={20} />
                        ) : (
                          <UserIcon size={20} />
                        )}
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-900 leading-none mb-1 group-hover:text-brand-primary">
                          {lead.firstName} {lead.lastName}
                        </h4>
                        {lead.lead_type && (
                          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                            {lead.lead_type}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-6">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                        <Mail size={14} className="text-slate-300" />{" "}
                        {lead.email}
                      </p>
                      <p className="text-xs text-slate-400 flex items-center gap-1.5">
                        <Smartphone size={14} className="text-slate-300" />{" "}
                        {lead.phone}
                      </p>
                    </div>
                  </td>
                  <td className="px-6 py-6">
                    <span
                      className={`px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-tight ${lead.isCorporate ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
                    >
                      {lead.isCorporate ? "Corporate" : "Individual"}
                    </span>
                  </td>
                  <td className="px-6 py-6">
                    {lead.status === "Converted" ? (
                      <div className="flex items-center gap-1.5 text-green-700 font-bold text-xs bg-green-50 px-2.5 py-1 rounded-full border border-green-100 w-fit">
                        <CheckCircle2 size={14} /> Converted
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-emerald-600 font-bold text-xs bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-100 w-fit">
                        <CheckCircle2 size={14} /> Active Lead
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-6 text-right">
                    <button className="p-2 text-slate-300 hover:text-brand-primary transition-colors">
                      <ArrowRight size={20} />
                    </button>
                  </td>
                </tr>
              ))}
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
