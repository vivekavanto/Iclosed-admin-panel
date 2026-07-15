"use client";
import React, { useState, useEffect } from "react";
import {
  Search,
  Plus,
  UserRound,
  X,
  Edit,
  Handshake,
  Copy,
  Check,
  Mail,
  Trash2,
  Info,
} from "lucide-react";
import { formatLocalDate } from "@/lib/formatDate";

type PartnerType = "Mortgage Broker" | "Real Estate Agent";

// Mirrors the `partners` table: agent_* is the person, brokerage_* the firm.
interface Partner {
  id: string;
  agent_name: string;
  agent_email: string | null;
  agent_phone: string | null;
  brokerage_type: PartnerType | null;
  brokerage_name: string | null;
  referral_code: string | null;
  clients_referred?: number;
  created_at: string;
}

// Mirrors the (555) 123-4567 formatter used across the admin forms.
function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits.length ? `(${digits}` : "";
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

const typeLabel = (t: PartnerType | null) =>
  t === "Real Estate Agent" ? "Agent" : t === "Mortgage Broker" ? "Broker" : "—";

const firstNameOf = (name?: string | null) =>
  (name ?? "").trim().split(/\s+/)[0] || "them";

const emptyForm = {
  id: "",
  agent_name: "",
  agent_email: "",
  agent_phone: "",
  brokerage_type: "Real Estate Agent" as PartnerType,
  brokerage_name: "",
};

type TabFilter = "all" | "Real Estate Agent" | "Mortgage Broker";

const Partners: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [tab, setTab] = useState<TabFilter>("all");
  const [partners, setPartners] = useState<Partner[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  // After a successful create, we reveal the generated code in the same modal.
  const [createdPartner, setCreatedPartner] = useState<Partner | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<Partner | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const resetForm = () => setForm({ ...emptyForm });

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/admin/partners");
        const data = await res.json();
        if (!res.ok) {
          setFetchError(data?.error || `HTTP ${res.status}`);
          return;
        }
        setPartners(data);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      }
    };
    load();
  }, []);

  const openCreate = () => {
    resetForm();
    setCreatedPartner(null);
    setIsModalOpen(true);
  };

  const handleEdit = (p: Partner) => {
    setForm({
      id: p.id,
      agent_name: p.agent_name ?? "",
      agent_email: p.agent_email ?? "",
      agent_phone: p.agent_phone ?? "",
      brokerage_type: p.brokerage_type ?? "Real Estate Agent",
      brokerage_name: p.brokerage_name ?? "",
    });
    setCreatedPartner(null);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setCreatedPartner(null);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const method = form.id ? "PUT" : "POST";
      const payload = {
        id: form.id || undefined,
        agent_name: form.agent_name.trim(),
        agent_email: form.agent_email.trim() || null,
        agent_phone: form.agent_phone.trim() || null,
        brokerage_type: form.brokerage_type || null,
        brokerage_name: form.brokerage_name.trim() || null,
      };
      const res = await fetch("/api/admin/partners", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result?.error || "Failed to save partner");

      if (form.id) {
        setPartners((prev) => prev.map((p) => (p.id === result.id ? { ...p, ...result } : p)));
        closeModal();
      } else {
        setPartners((prev) => [result, ...prev]);
        // Reveal the generated code — step 2 of the Add flow.
        setCreatedPartner(result);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error saving partner.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (p: Partner) => {
    setDeletingId(p.id);
    try {
      const res = await fetch(
        `/api/admin/partners?id=${encodeURIComponent(p.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setPartners((prev) => prev.filter((x) => x.id !== p.id));
      setConfirmDelete(null);
    } catch (err) {
      alert(`Failed to delete partner: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const copyCode = async (code: string, id: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      alert("Could not copy to clipboard.");
    }
  };

  const sendCode = async (p: Partner) => {
    setSendingId(p.id);
    try {
      const res = await fetch("/api/admin/partners/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      alert(`Referral code sent to ${p.agent_email}.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to send code.");
    } finally {
      setSendingId(null);
    }
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const agentCount = partners.filter((p) => p.brokerage_type === "Real Estate Agent").length;
  const brokerCount = partners.filter((p) => p.brokerage_type === "Mortgage Broker").length;
  const clientsReferred = partners.reduce((sum, p) => sum + (p.clients_referred ?? 0), 0);

  const filtered = partners.filter((p) => {
    if (tab !== "all" && p.brokerage_type !== tab) return false;
    const q = searchTerm.toLowerCase();
    if (!q) return true;
    return (
      p.agent_name.toLowerCase().includes(q) ||
      (p.agent_email ?? "").toLowerCase().includes(q) ||
      (p.brokerage_name ?? "").toLowerCase().includes(q) ||
      (p.referral_code ?? "").toLowerCase().includes(q)
    );
  });

  const inputClasses =
    "w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white";

  // The referral code is generated server-side on create and never changes, so
  // it's shown read-only while editing — pulled from the row being edited.
  const editingCode = form.id
    ? partners.find((p) => p.id === form.id)?.referral_code ?? null
    : null;

  const TABS: { id: TabFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "Real Estate Agent", label: "Agents" },
    { id: "Mortgage Broker", label: "Brokers" },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {fetchError && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
          <span className="font-black">DB Fetch Error:</span> {fetchError}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center tracking-tight">
            <Handshake className="mr-3 text-brand-primary" size={32} />
            Partners &amp; Codes
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {agentCount} real estate {agentCount === 1 ? "agent" : "agents"} ·{" "}
            {brokerCount} mortgage {brokerCount === 1 ? "broker" : "brokers"} ·{" "}
            {clientsReferred} {clientsReferred === 1 ? "client" : "clients"} referred
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative w-full md:w-80">
            <input
              type="text"
              placeholder="Search partners..."
              className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all bg-white shadow-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <Search className="absolute left-3 top-3 text-slate-400" size={20} />
          </div>
          <button
            onClick={openCreate}
            className="bg-brand-primary text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus size={20} />
            Add Partner
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
              tab === t.id
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-x-auto">
        <table className="w-full min-w-[1000px] text-left text-sm">
          <thead className="bg-slate-50/30 border-b border-slate-100">
            <tr className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
              <th className="px-6 py-5 w-12">#</th>
              <th className="px-4 py-5">Partner</th>
              <th className="px-4 py-5">Type</th>
              <th className="px-4 py-5">Company</th>
              <th className="px-4 py-5">Phone</th>
              <th className="px-4 py-5">Referral Code</th>
              <th className="px-4 py-5 text-center w-24">Clients</th>
              <th className="px-4 py-5 w-40">Date Added</th>
              <th className="px-4 py-5 text-center w-28">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filtered.map((p, idx) => (
              <tr key={p.id} className="hover:bg-slate-50/50 transition-colors group">
                <td className="px-6 py-4 text-slate-400 font-medium">{idx + 1}</td>
                <td className="px-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-brand-light flex items-center justify-center rounded-lg shrink-0">
                      <UserRound className="text-brand-primary" size={16} />
                    </div>
                    <div className="min-w-0">
                      <span className="font-bold text-slate-800 text-sm leading-snug block truncate">
                        {p.agent_name}
                      </span>
                      <span className="text-xs text-slate-400 truncate block">
                        {p.agent_email || <span className="italic text-slate-300">No email</span>}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4">
                  {p.brokerage_type ? (
                    <span
                      className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ring-1 ${
                        p.brokerage_type === "Real Estate Agent"
                          ? "bg-blue-50 text-blue-700 ring-blue-200"
                          : "bg-amber-50 text-amber-700 ring-amber-200"
                      }`}
                    >
                      {typeLabel(p.brokerage_type)}
                    </span>
                  ) : (
                    <span className="italic text-slate-300 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-4">
                  <span className="text-xs text-slate-600 truncate block max-w-[180px]">
                    {p.brokerage_name || <span className="italic text-slate-300">—</span>}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <span className="text-xs text-slate-600 whitespace-nowrap">
                    {p.agent_phone || <span className="italic text-slate-300">—</span>}
                  </span>
                </td>
                <td className="px-4 py-4">
                  {p.referral_code ? (
                    <div className="flex items-center gap-2">
                      <code className="font-bold text-slate-800 text-xs font-mono bg-brand-light text-brand-primary px-2.5 py-1 rounded-md">
                        {p.referral_code}
                      </code>
                      <button
                        onClick={() => copyCode(p.referral_code!, p.id)}
                        className="text-slate-400 hover:text-brand-primary transition-colors p-1"
                        title="Copy code"
                      >
                        {copiedId === p.id ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                      </button>
                    </div>
                  ) : (
                    <span className="italic text-slate-300 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-4 text-center">
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600">
                    {p.clients_referred ?? 0}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <span className="text-xs text-slate-400 font-medium">
                    {formatLocalDate(p.created_at) || "—"}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <div className="flex justify-center items-center gap-1">
                    <button
                      onClick={() => sendCode(p)}
                      disabled={sendingId === p.id || !p.agent_email}
                      className="text-slate-400 hover:text-brand-primary transition-colors p-1 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={p.agent_email ? "Resend code by email" : "No email on file"}
                    >
                      <Mail size={18} />
                    </button>
                    <button
                      onClick={() => handleEdit(p)}
                      className="text-brand-primary hover:text-brand-primaryHover transition-colors p-1"
                      title="Edit partner"
                    >
                      <Edit size={18} />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(p)}
                      className="text-slate-400 hover:text-red-600 transition-colors p-1"
                      title="Delete partner"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-12 py-20 text-center text-slate-400">
                  <Handshake size={48} className="text-slate-100 mb-4 mx-auto" />
                  <p className="font-medium text-lg">No partners found.</p>
                  <button
                    onClick={openCreate}
                    className="text-brand-primary text-sm font-bold mt-2 hover:underline"
                  >
                    Add your first partner
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create / Edit / Success Modal */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={createdPartner ? "Partner created" : form.id ? "Edit Partner" : "Add Partner"}
          className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 transition-[left] duration-300"
          onClick={closeModal}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">
                  {createdPartner ? "Partner added" : form.id ? "Edit partner" : "Add a partner"}
                </h3>
                <p className="text-xs text-gray-400 mt-1">
                  {createdPartner
                    ? "Share the generated referral code below."
                    : form.id
                      ? "Update this partner's details. The referral code stays the same."
                      : "A unique referral code is generated automatically."}
                </p>
              </div>
              <button
                onClick={closeModal}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            {createdPartner ? (
              /* Step 2 — success reveal */
              <div className="flex-1 flex flex-col min-h-0">
                <div className="px-6 py-8 space-y-6 overflow-y-auto flex-1">
                  <div className="text-center">
                    <div className="w-14 h-14 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
                      <Check className="text-green-600" size={28} />
                    </div>
                    <p className="text-sm text-slate-600">
                      <span className="font-bold text-slate-800">{createdPartner.agent_name}</span> is
                      now a partner. Their referral code is:
                    </p>
                  </div>
                  <div className="flex flex-col items-center gap-3">
                    <code className="font-mono text-2xl font-bold tracking-widest text-brand-primary bg-brand-light px-8 py-4 rounded-xl">
                      {createdPartner.referral_code}
                    </code>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => copyCode(createdPartner.referral_code!, createdPartner.id)}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50 transition-colors"
                      >
                        {copiedId === createdPartner.id ? (
                          <>
                            <Check size={16} className="text-green-600" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy size={16} /> Copy code
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => sendCode(createdPartner)}
                        disabled={sendingId === createdPartner.id || !createdPartner.agent_email}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-semibold hover:bg-brand-primaryHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title={createdPartner.agent_email ? undefined : "No email on file"}
                      >
                        <Mail size={16} />
                        {sendingId === createdPartner.id
                          ? "Sending..."
                          : `Email code to ${firstNameOf(createdPartner.agent_name)}`}
                      </button>
                    </div>
                    {!createdPartner.agent_email && (
                      <p className="text-xs text-amber-600">
                        No email on file — add one to email the code.
                      </p>
                    )}
                  </div>
                </div>
                <div className="px-6 py-4 border-t border-gray-100">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="w-full py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006]"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              /* Step 1 — form */
              <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
                <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
                  {/* Type toggle */}
                  <div>
                    <label className="text-sm font-semibold text-gray-800 block mb-2">Partner Type</label>
                    <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, brokerage_type: "Real Estate Agent" }))}
                        className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${form.brokerage_type === "Real Estate Agent" ? "bg-[#C10007] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                      >
                        Real Estate Agent
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, brokerage_type: "Mortgage Broker" }))}
                        className={`flex-1 py-2.5 text-sm font-semibold transition-colors border-l border-gray-200 ${form.brokerage_type === "Mortgage Broker" ? "bg-[#C10007] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                      >
                        Mortgage Broker
                      </button>
                    </div>
                  </div>

                  {/* Name */}
                  <div>
                    <label className="text-sm font-semibold text-gray-800 block mb-2">
                      Full Name <span className="text-[#C10007]">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Jane Smith"
                      className={inputClasses}
                      value={form.agent_name}
                      onChange={(e) => setForm((p) => ({ ...p, agent_name: e.target.value }))}
                    />
                  </div>

                  {/* Company */}
                  <div>
                    <label className="text-sm font-semibold text-gray-800 block mb-2">Company</label>
                    <input
                      type="text"
                      placeholder="Brokerage / agency name"
                      className={inputClasses}
                      value={form.brokerage_name}
                      onChange={(e) => setForm((p) => ({ ...p, brokerage_name: e.target.value }))}
                    />
                  </div>

                  {/* Email + Phone */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-semibold text-gray-800 block mb-2">Email</label>
                      <input
                        type="email"
                        placeholder="jane@brokerage.com"
                        className={inputClasses}
                        value={form.agent_email}
                        onChange={(e) => setForm((p) => ({ ...p, agent_email: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-semibold text-gray-800 block mb-2">Phone</label>
                      <input
                        type="tel"
                        inputMode="numeric"
                        placeholder="(555) 123-4567"
                        className={inputClasses}
                        value={form.agent_phone}
                        onChange={(e) => setForm((p) => ({ ...p, agent_phone: formatPhone(e.target.value) }))}
                      />
                    </div>
                  </div>

                  {/* Referral code — auto-generated on create, read-only on edit */}
                  {form.id ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 border border-slate-100 px-4 py-3">
                      <span className="text-xs text-slate-500">
                        Referral code stays the same when you edit details.
                      </span>
                      <code className="font-mono text-sm font-bold tracking-wider text-slate-800 shrink-0">
                        {editingCode ?? "—"}
                      </code>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-100 px-4 py-3">
                      <Info size={16} className="text-slate-400 shrink-0" />
                      <span className="text-xs text-slate-500">
                        We&apos;ll generate a unique referral code on the next step.
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? "Saving..." : form.id ? "Save changes" : "Generate code"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200 transition-[left] duration-300">
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            onClick={() => deletingId === null && setConfirmDelete(null)}
          />
          <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md relative z-10 animate-in zoom-in-95 duration-200">
            <div className="p-8">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 bg-red-50 flex items-center justify-center rounded-xl shrink-0">
                  <Trash2 className="text-red-600" size={22} />
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-black text-slate-900 leading-tight">Delete Partner</h3>
                  <p className="text-sm text-slate-500 font-medium mt-2 leading-relaxed">
                    Are you sure you want to delete{" "}
                    <span className="font-bold text-slate-800">“{confirmDelete.agent_name}”</span>? Their
                    referral code will stop resolving.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-8">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  disabled={deletingId !== null}
                  className="px-6 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50 transition-all disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(confirmDelete)}
                  disabled={deletingId !== null}
                  className="px-6 py-2.5 bg-red-600 text-white rounded-xl font-bold text-sm shadow-lg shadow-red-600/20 hover:bg-red-700 transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {deletingId === confirmDelete.id ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Partners;
