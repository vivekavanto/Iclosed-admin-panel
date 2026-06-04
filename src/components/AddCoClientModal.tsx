"use client";

import React, { useMemo, useState } from "react";
import { X, Loader2, UserPlus } from "lucide-react";

interface AddCoClientModalProps {
  dealId: string;
  /** The current deal's type, e.g. "Purchase", "Sale", "Purchase & Sale". */
  dealType: string;
  /** Purchase-side property address, shown read-only for context. */
  propertyAddress?: string;
  /** Selling-side property address (P&S / Sale), shown for the co-seller side. */
  sellingPropertyAddress?: string;
  onClose: () => void;
  /** Called after a co-client was successfully added + converted. */
  onAdded: (result: { role: string; file_number?: string }) => void;
}

type Role = "purchaser" | "seller";

const inputClass =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary";

const AddCoClientModal: React.FC<AddCoClientModalProps> = ({
  dealId,
  dealType,
  propertyAddress,
  sellingPropertyAddress,
  onClose,
  onAdded,
}) => {
  // Which sides this deal can take. A Purchase & Sale deal can take both a
  // co-purchaser and a co-seller; a single-side deal takes only its own side.
  const { allowsPurchaser, allowsSeller } = useMemo(() => {
    const t = (dealType ?? "").toLowerCase();
    const isPS = t.includes("purchase") && t.includes("sale");
    return {
      allowsPurchaser: isPS || t.includes("purchase") || t.includes("refinance"),
      allowsSeller: isPS || t === "sale" || t.includes("sale"),
    };
  }, [dealType]);

  const [role, setRole] = useState<Role>(allowsPurchaser ? "purchaser" : "seller");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canChooseRole = allowsPurchaser && allowsSeller;

  const submit = async () => {
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/co-clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          phone: phone.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to add co-client.");
      }
      onAdded({ role: data.role ?? (role === "purchaser" ? "Co-Purchaser" : "Co-Seller"), file_number: data.file_number });
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const roleLabel = role === "purchaser" ? "Co-Purchaser" : "Co-Seller";
  const contextAddress =
    role === "seller"
      ? sellingPropertyAddress || propertyAddress
      : propertyAddress || sellingPropertyAddress;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add co-purchaser or co-seller"
      className="fixed inset-0 z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
      onClick={onClose}
    >
      <div
        className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[480px] slide-in-from-right relative lg:h-auto lg:max-h-[90vh] lg:rounded-2xl lg:zoom-in lg:duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
          <div className="min-w-0 flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 flex-shrink-0">
              <UserPlus size={14} />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900">Add {roleLabel}</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                They&apos;ll be linked to this file and emailed an invite.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          {canChooseRole && (
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1.5">Role</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setRole("purchaser")}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    role === "purchaser"
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  Co-Purchaser
                </button>
                <button
                  type="button"
                  onClick={() => setRole("seller")}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    role === "seller"
                      ? "border-orange-500 bg-orange-50 text-orange-700"
                      : "border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  Co-Seller
                </button>
              </div>
            </div>
          )}

          {contextAddress && (
            <div className="rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-900">
              Adding a <span className="font-bold">{roleLabel}</span> for{" "}
              <span className="font-semibold">{contextAddress}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1.5">First name</label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={inputClass}
                placeholder="John"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1.5">Last name</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={inputClass}
                placeholder="Doe"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder="john@doe.com"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1.5">
              Phone <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
              placeholder="(555) 123-4567"
            />
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold bg-[#C10007] text-white hover:bg-[#a30006] transition-colors shadow-sm disabled:opacity-60"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
            {saving ? "Adding…" : `Add ${roleLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddCoClientModal;
