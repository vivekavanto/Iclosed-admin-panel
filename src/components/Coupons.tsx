"use client";
import React, { useState, useEffect } from "react";
import { Search, Plus, Ticket, X, Edit, Trash2, Percent, DollarSign } from "lucide-react";
import { formatLocalDate } from "@/lib/formatDate";

interface Coupon {
  id: string;
  code: string;
  discount_type: "percent" | "fixed" | null;
  discount_value: number | null;
  is_active: boolean;
  created_at: string;
  // reverse join — brokers currently mapped to this coupon
  brokers?: { id: string; name: string }[] | null;
}

const emptyForm = {
  id: "",
  code: "",
  discount_type: "percent" as "percent" | "fixed",
  discount_value: "",
  is_active: true,
};

const formatDiscount = (c: Coupon) => {
  if (c.discount_value == null || !c.discount_type) return "—";
  return c.discount_type === "percent"
    ? `${c.discount_value}%`
    : `$${c.discount_value}`;
};

const Coupons: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Coupon | null>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const resetForm = () => setForm({ ...emptyForm });

  useEffect(() => {
    const getCoupons = async () => {
      try {
        const res = await fetch("/api/admin/coupons");
        const data = await res.json();
        if (!res.ok) {
          setFetchError(data?.error || `HTTP ${res.status}`);
          return;
        }
        setCoupons(data);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      }
    };
    getCoupons();
  }, []);

  const handleEdit = (coupon: Coupon) => {
    setForm({
      id: coupon.id,
      code: coupon.code ?? "",
      discount_type: coupon.discount_type ?? "percent",
      discount_value: coupon.discount_value != null ? String(coupon.discount_value) : "",
      is_active: coupon.is_active ?? true,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (coupon: Coupon) => {
    setDeletingId(coupon.id);
    try {
      const res = await fetch(
        `/api/admin/coupons?id=${encodeURIComponent(coupon.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setCoupons((prev) => prev.filter((c) => c.id !== coupon.id));
      setConfirmDelete(null);
    } catch (err) {
      alert(`Failed to delete coupon: ${err instanceof Error ? err.message : String(err)}`);
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
        code: form.code.trim(),
        discount_type: form.discount_type,
        discount_value: form.discount_value === "" ? null : Number(form.discount_value),
        is_active: form.is_active,
      };
      const res = await fetch("/api/admin/coupons", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result?.error || "Failed to save coupon");

      if (form.id) {
        setCoupons((prev) => prev.map((c) => (c.id === result.id ? result : c)));
      } else {
        setCoupons((prev) => [result, ...prev]);
      }
      setIsModalOpen(false);
      resetForm();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error saving coupon.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const filtered = coupons.filter((c) =>
    c.code.toLowerCase().includes(searchTerm.toLowerCase()),
  );

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
            <Ticket className="mr-3 text-brand-primary" size={32} />
            Coupons
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Shared discount codes. A single coupon can be mapped to many brokers.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative w-full md:w-80">
            <input
              type="text"
              placeholder="Search coupons..."
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
            New Coupon
          </button>
        </div>
      </div>

      {/* List */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-x-auto">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead className="bg-slate-50/30 border-b border-slate-100">
            <tr className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
              <th className="px-6 py-5">Code</th>
              <th className="px-4 py-5">Discount</th>
              <th className="px-4 py-5 text-center w-32">Mapped Brokers</th>
              <th className="px-4 py-5 text-center w-24">Active</th>
              <th className="px-4 py-5 w-40">Created</th>
              <th className="px-4 py-5 text-center w-24">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filtered.map((coupon) => (
              <tr key={coupon.id} className="hover:bg-slate-50/50 transition-colors group">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-brand-light flex items-center justify-center rounded-lg shrink-0">
                      <Ticket className="text-brand-primary" size={16} />
                    </div>
                    <code className="font-bold text-slate-800 text-sm font-mono bg-slate-50 px-2 py-1 rounded-md border border-slate-100">
                      {coupon.code}
                    </code>
                  </div>
                </td>
                <td className="px-4 py-4">
                  <span className="text-sm font-semibold text-slate-700">
                    {formatDiscount(coupon)}
                  </span>
                </td>
                <td className="px-4 py-4 text-center">
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600">
                    {coupon.brokers?.length ?? 0}
                  </span>
                </td>
                <td className="px-4 py-4 text-center">
                  <div className="flex justify-center">
                    {coupon.is_active ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-green-50 text-green-700 ring-1 ring-green-200">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-500 ring-1 ring-slate-200">
                        Inactive
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-4">
                  <span className="text-xs text-slate-400 font-medium">
                    {formatLocalDate(coupon.created_at) || "—"}
                  </span>
                </td>
                <td className="px-4 py-4 text-center">
                  <div className="flex justify-center items-center gap-1">
                    <button
                      onClick={() => handleEdit(coupon)}
                      className="text-brand-primary hover:text-brand-primaryHover transition-colors p-1"
                      title="Edit coupon"
                    >
                      <Edit size={18} />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(coupon)}
                      className="text-slate-400 hover:text-red-600 transition-colors p-1"
                      title="Delete coupon"
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
                  <Ticket size={48} className="text-slate-100 mb-4 mx-auto" />
                  <p className="font-medium text-lg">No coupons found.</p>
                  <button
                    onClick={() => { resetForm(); setIsModalOpen(true); }}
                    className="text-brand-primary text-sm font-bold mt-2 hover:underline"
                  >
                    Create your first coupon
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
          aria-label={form.id ? "Edit Coupon" : "New Coupon"}
          className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 transition-[left] duration-300"
          onClick={() => { setIsModalOpen(false); resetForm(); }}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[480px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">
                  {form.id ? "Edit Coupon" : "New Coupon"}
                </h3>
                <p className="text-xs text-gray-400 mt-1">
                  {form.id ? "Update this discount code." : "Create a shared discount code brokers can be mapped to."}
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
                {/* Code */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Coupon Code <span className="text-[#C10007]">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. BROKER25"
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white font-mono"
                    value={form.code}
                    onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
                  />
                </div>

                {/* Discount type + value */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-gray-800 block mb-2">Discount Type</label>
                    <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, discount_type: "percent" }))}
                        className={`flex-1 flex items-center justify-center gap-1 py-2.5 text-sm font-semibold transition-colors ${form.discount_type === "percent" ? "bg-[#C10007] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                      >
                        <Percent size={14} /> Percent
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, discount_type: "fixed" }))}
                        className={`flex-1 flex items-center justify-center gap-1 py-2.5 text-sm font-semibold transition-colors border-l border-gray-200 ${form.discount_type === "fixed" ? "bg-[#C10007] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                      >
                        <DollarSign size={14} /> Fixed
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-gray-800 block mb-2">Discount Value</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={form.discount_type === "percent" ? "e.g. 25" : "e.g. 100"}
                      className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                      value={form.discount_value}
                      onChange={(e) => setForm((p) => ({ ...p, discount_value: e.target.value }))}
                    />
                  </div>
                </div>

                {/* Active toggle */}
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">Active Coupon</p>
                    <p className="text-xs text-gray-500 mt-0.5">Only active coupons resolve on the intake form.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, is_active: !p.is_active }))}
                    className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${form.is_active ? "bg-[#C10007]" : "bg-slate-300"}`}
                  >
                    <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${form.is_active ? "translate-x-6" : "translate-x-0"}`} />
                  </button>
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
                  {isSubmitting ? "Saving..." : form.id ? "Update Coupon" : "Create Coupon"}
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
                  <h3 className="text-xl font-black text-slate-900 leading-tight">Delete Coupon</h3>
                  <p className="text-sm text-slate-500 font-medium mt-2 leading-relaxed">
                    Are you sure you want to delete{" "}
                    <span className="font-bold text-slate-800">“{confirmDelete.code}”</span>?
                    Any brokers mapped to it will be unlinked.
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

export default Coupons;
