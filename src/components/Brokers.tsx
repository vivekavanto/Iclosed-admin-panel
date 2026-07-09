"use client";
import React, { useState, useEffect } from "react";
import { Search, Plus, UserRound, X, Edit, Trash2, Ticket } from "lucide-react";
import { formatLocalDate } from "@/lib/formatDate";

interface CouponRef {
  id: string;
  code: string;
  discount_type: "percent" | "fixed" | null;
  discount_value: number | null;
}

interface Broker {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  type: "Mortgage Broker" | "Real Estate Agent" | null;
  company: string | null;
  coupon_id: string | null;
  created_at: string;
  coupons?: CouponRef | null; // joined coupon
}

const BROKER_TYPES = ["Mortgage Broker", "Real Estate Agent"] as const;

// Mirrors the (555) 123-4567 formatter used in CoPersonPersonalInfoModal.tsx.
function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits.length ? `(${digits}` : "";
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

const emptyForm = {
  id: "",
  name: "",
  email: "",
  phone: "",
  type: "" as "" | "Mortgage Broker" | "Real Estate Agent",
  company: "",
  coupon_id: "",
};

const Brokers: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [coupons, setCoupons] = useState<CouponRef[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Broker | null>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const resetForm = () => setForm({ ...emptyForm });

  useEffect(() => {
    const load = async () => {
      try {
        const [bRes, cRes] = await Promise.all([
          fetch("/api/admin/brokers"),
          fetch("/api/admin/coupons"),
        ]);
        const bData = await bRes.json();
        const cData = await cRes.json();
        if (!bRes.ok) {
          setFetchError(bData?.error || `HTTP ${bRes.status}`);
          return;
        }
        setBrokers(bData);
        if (cRes.ok) setCoupons(cData);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      }
    };
    load();
  }, []);

  const handleEdit = (broker: Broker) => {
    setForm({
      id: broker.id,
      name: broker.name ?? "",
      email: broker.email ?? "",
      phone: broker.phone ?? "",
      type: broker.type ?? "",
      company: broker.company ?? "",
      coupon_id: broker.coupon_id ?? "",
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (broker: Broker) => {
    setDeletingId(broker.id);
    try {
      const res = await fetch(
        `/api/admin/brokers?id=${encodeURIComponent(broker.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setBrokers((prev) => prev.filter((b) => b.id !== broker.id));
      setConfirmDelete(null);
    } catch (err) {
      alert(`Failed to delete broker: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const method = form.id ? "PUT" : "POST";
      const payload = {
        id: form.id || undefined,
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        type: form.type || null,
        company: form.company.trim() || null,
        coupon_id: form.coupon_id || null,
      };
      const res = await fetch("/api/admin/brokers", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result?.error || "Failed to save broker");

      if (form.id) {
        setBrokers((prev) => prev.map((b) => (b.id === result.id ? result : b)));
      } else {
        setBrokers((prev) => [result, ...prev]);
      }
      setIsModalOpen(false);
      resetForm();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error saving broker.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const filtered = brokers.filter((b) => {
    const q = searchTerm.toLowerCase();
    return (
      b.name.toLowerCase().includes(q) ||
      (b.email ?? "").toLowerCase().includes(q) ||
      (b.company ?? "").toLowerCase().includes(q)
    );
  });

  const inputClasses =
    "w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white";

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
            <UserRound className="mr-3 text-brand-primary" size={32} />
            Brokers
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Referral sources. Map each broker to a shared coupon.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative w-full md:w-80">
            <input
              type="text"
              placeholder="Search brokers..."
              className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all bg-white shadow-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <Search className="absolute left-3 top-3 text-slate-400" size={20} />
          </div>
          <button
            onClick={() => { resetForm(); setIsModalOpen(true); }}
            className="bg-brand-primary text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus size={20} />
            New Broker
          </button>
        </div>
      </div>

      {/* List */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-x-auto">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="bg-slate-50/30 border-b border-slate-100">
            <tr className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
              <th className="px-6 py-5">Name</th>
              <th className="px-4 py-5">Type</th>
              <th className="px-4 py-5">Contact</th>
              <th className="px-4 py-5">Coupon</th>
              <th className="px-4 py-5 w-40">Created</th>
              <th className="px-4 py-5 text-center w-24">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filtered.map((broker) => (
              <tr key={broker.id} className="hover:bg-slate-50/50 transition-colors group">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-brand-light flex items-center justify-center rounded-lg shrink-0">
                      <UserRound className="text-brand-primary" size={16} />
                    </div>
                    <div className="min-w-0">
                      <span className="font-bold text-slate-800 text-sm leading-snug block truncate">
                        {broker.name}
                      </span>
                      {broker.company && (
                        <span className="text-xs text-slate-400 truncate block">{broker.company}</span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4">
                  {broker.type ? (
                    <span className="text-xs font-medium text-slate-600">{broker.type}</span>
                  ) : (
                    <span className="italic text-slate-300 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-4">
                  <div className="flex flex-col">
                    <span className="text-xs text-slate-600 truncate max-w-[200px]">
                      {broker.email || <span className="italic text-slate-300">No email</span>}
                    </span>
                    {broker.phone && (
                      <span className="text-xs text-slate-400">{broker.phone}</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-4">
                  {broker.coupons ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-brand-light text-brand-primary">
                      <Ticket size={12} />
                      {broker.coupons.code}
                    </span>
                  ) : (
                    <span className="italic text-slate-300 text-xs">Unmapped</span>
                  )}
                </td>
                <td className="px-4 py-4">
                  <span className="text-xs text-slate-400 font-medium">
                    {formatLocalDate(broker.created_at) || "—"}
                  </span>
                </td>
                <td className="px-4 py-4 text-center">
                  <div className="flex justify-center items-center gap-1">
                    <button
                      onClick={() => handleEdit(broker)}
                      className="text-brand-primary hover:text-brand-primaryHover transition-colors p-1"
                      title="Edit broker"
                    >
                      <Edit size={18} />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(broker)}
                      className="text-slate-400 hover:text-red-600 transition-colors p-1"
                      title="Delete broker"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-12 py-20 text-center text-slate-400">
                  <UserRound size={48} className="text-slate-100 mb-4 mx-auto" />
                  <p className="font-medium text-lg">No brokers found.</p>
                  <button
                    onClick={() => { resetForm(); setIsModalOpen(true); }}
                    className="text-brand-primary text-sm font-bold mt-2 hover:underline"
                  >
                    Create your first broker
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create/Edit Modal */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={form.id ? "Edit Broker" : "New Broker"}
          className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 transition-[left] duration-300"
          onClick={() => { setIsModalOpen(false); resetForm(); }}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">
                  {form.id ? "Edit Broker" : "New Broker"}
                </h3>
                <p className="text-xs text-gray-400 mt-1">
                  {form.id ? "Update this referral source." : "Add a referral source and map it to a coupon."}
                </p>
              </div>
              <button
                onClick={() => { setIsModalOpen(false); resetForm(); }}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
              <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
                {/* Name */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Broker Name <span className="text-[#C10007]">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Jane Doe"
                    className={inputClasses}
                    value={form.name}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
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
                      value={form.email}
                      onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-gray-800 block mb-2">Phone</label>
                    <input
                      type="tel"
                      inputMode="numeric"
                      placeholder="(555) 123-4567"
                      className={inputClasses}
                      value={form.phone}
                      onChange={(e) => setForm((p) => ({ ...p, phone: formatPhone(e.target.value) }))}
                    />
                  </div>
                </div>

                {/* Type + Company */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-gray-800 block mb-2">Type</label>
                    <select
                      className={inputClasses}
                      value={form.type}
                      onChange={(e) => setForm((p) => ({ ...p, type: e.target.value as typeof p.type }))}
                    >
                      <option value="">—</option>
                      {BROKER_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-gray-800 block mb-2">Company</label>
                    <input
                      type="text"
                      placeholder="Brokerage name"
                      className={inputClasses}
                      value={form.company}
                      onChange={(e) => setForm((p) => ({ ...p, company: e.target.value }))}
                    />
                  </div>
                </div>

                {/* Coupon mapping */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">Coupon</label>
                  <select
                    className={inputClasses}
                    value={form.coupon_id}
                    onChange={(e) => setForm((p) => ({ ...p, coupon_id: e.target.value }))}
                  >
                    <option value="">No coupon</option>
                    {coupons.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code}
                        {c.discount_value != null && c.discount_type
                          ? ` (${c.discount_type === "percent" ? `${c.discount_value}%` : `$${c.discount_value}`})`
                          : ""}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    A single coupon can be shared across many brokers.
                  </p>
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => { setIsModalOpen(false); resetForm(); }}
                  className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? "Saving..." : form.id ? "Update Broker" : "Create Broker"}
                </button>
              </div>
            </form>
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
                  <h3 className="text-xl font-black text-slate-900 leading-tight">Delete Broker</h3>
                  <p className="text-sm text-slate-500 font-medium mt-2 leading-relaxed">
                    Are you sure you want to delete{" "}
                    <span className="font-bold text-slate-800">“{confirmDelete.name}”</span>?
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

export default Brokers;
