"use client";

import React, { useEffect, useState } from "react";

interface AvailabilityData {
  lawyer: { initials: string; fullName: string };
  date: string;
  durationMinutes: number;
  officeAddress: string;
  disclaimer: string;
  slots: string[];
}

interface ConfirmedBooking {
  startAt: string;
  endAt: string;
  lawyerName: string;
  location: string;
  meetLink: string | null;
  manageUrl: string;
}

function todayLocalIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatSlot(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Toronto",
  });
}

export interface SigningPrefill {
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  propertyAddress?: string;
  closingDate?: string;
  dealType?: string;
  fileNumber?: string;
}

export default function SigningBookingPage({
  lawyerInitials,
  prefill,
}: {
  lawyerInitials: string;
  prefill?: SigningPrefill;
}) {
  const [date, setDate] = useState(todayLocalIso());
  const [availability, setAvailability] = useState<AvailabilityData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  // Derived rather than its own state set synchronously at the top of the
  // effect below (react-hooks/set-state-in-effect): still loading whenever the
  // slots on screen don't match the date currently selected.
  const loadingSlots = availability?.date !== date && !notFound;

  const [form, setForm] = useState({
    clientName: prefill?.clientName ?? "",
    clientEmail: prefill?.clientEmail ?? "",
    clientPhone: prefill?.clientPhone ?? "",
    propertyAddress: prefill?.propertyAddress ?? "",
    closingDate: prefill?.closingDate ?? "",
    dealType: prefill?.dealType ?? "",
    appointmentType: "in_person",
    fileNumber: prefill?.fileNumber ?? "",
    extraGuestsText: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedBooking | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/signing/lawyers/${lawyerInitials}/availability?date=${date}`);
      if (cancelled) return;
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const json = await res.json();
      if (cancelled) return;
      if (json.success) setAvailability(json.data);
      setSelectedSlot(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [date, lawyerInitials]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSlot) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/signing/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lawyerInitials,
          startAt: selectedSlot,
          clientName: form.clientName,
          clientEmail: form.clientEmail,
          clientPhone: form.clientPhone || undefined,
          propertyAddress: form.propertyAddress || undefined,
          closingDate: form.closingDate || undefined,
          dealType: form.dealType || undefined,
          appointmentType: form.appointmentType,
          fileNumber: form.fileNumber || undefined,
          extraGuests: form.extraGuestsText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Could not book that time.");
        return;
      }
      setConfirmed(json.data);
    } finally {
      setSubmitting(false);
    }
  }

  if (notFound) {
    return (
      <div className="max-w-xl mx-auto p-8 text-center">
        <h1 className="text-xl font-semibold">Booking page not found</h1>
        <p className="text-base-content/60 mt-2">
          This signing-appointment link is not valid. Please contact the office for a new link.
        </p>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div className="max-w-xl mx-auto p-8">
        <h1 className="text-xl font-semibold mb-4">Appointment confirmed</h1>
        <div className="bg-base-200 rounded-lg p-4 space-y-2 text-sm">
          <p>
            <strong>{new Date(confirmed.startAt).toLocaleString("en-US", { timeZone: "America/Toronto", dateStyle: "full", timeStyle: "short" })}</strong>
          </p>
          <p>With {confirmed.lawyerName}</p>
          {confirmed.meetLink ? (
            <p>
              Join: <a className="link link-primary" href={confirmed.meetLink}>{confirmed.meetLink}</a>
            </p>
          ) : (
            <p>Location: {confirmed.location}</p>
          )}
        </div>
        <p className="text-sm mt-4">
          Need to change this? <a className="link link-primary" href={confirmed.manageUrl}>Manage your appointment</a>
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto p-6 sm:p-8">
      <h1 className="text-xl font-semibold mb-1">
        Signing Appointment{availability ? ` — ${availability.lawyer.fullName}` : ""}
      </h1>
      {availability && (
        <p className="text-sm text-base-content/60 mb-6">{availability.disclaimer}</p>
      )}

      <div className="mb-4">
        <label className="form-control w-48">
          <span className="label-text text-xs">Date</span>
          <input
            type="date"
            className="input input-bordered input-sm"
            value={date}
            min={todayLocalIso()}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>

      <div className="mb-6">
        {loadingSlots ? (
          <p className="text-sm text-base-content/60">Loading times…</p>
        ) : availability && availability.slots.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {availability.slots.map((slot) => (
              <button
                key={slot}
                type="button"
                className={`btn btn-sm ${selectedSlot === slot ? "btn-primary" : "btn-outline"}`}
                onClick={() => setSelectedSlot(slot)}
              >
                {formatSlot(slot)}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-base-content/60">No times available on this date.</p>
        )}
      </div>

      {selectedSlot && (
        <form onSubmit={submit} className="space-y-3 border-t border-base-300 pt-6">
          <div className="grid grid-cols-2 gap-3">
            <label className="form-control">
              <span className="label-text text-xs">Name *</span>
              <input
                required
                className="input input-bordered input-sm"
                value={form.clientName}
                onChange={(e) => setForm({ ...form, clientName: e.target.value })}
              />
            </label>
            <label className="form-control">
              <span className="label-text text-xs">Email *</span>
              <input
                required
                type="email"
                className="input input-bordered input-sm"
                value={form.clientEmail}
                onChange={(e) => setForm({ ...form, clientEmail: e.target.value })}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="form-control">
              <span className="label-text text-xs">Phone</span>
              <input
                className="input input-bordered input-sm"
                value={form.clientPhone}
                onChange={(e) => setForm({ ...form, clientPhone: e.target.value })}
              />
            </label>
            <label className="form-control">
              <span className="label-text text-xs">File number</span>
              <input
                className="input input-bordered input-sm"
                value={form.fileNumber}
                onChange={(e) => setForm({ ...form, fileNumber: e.target.value })}
              />
            </label>
          </div>
          <label className="form-control">
            <span className="label-text text-xs">Property address *</span>
            <input
              required
              className="input input-bordered input-sm"
              value={form.propertyAddress}
              onChange={(e) => setForm({ ...form, propertyAddress: e.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="form-control">
              <span className="label-text text-xs">Closing date</span>
              <input
                type="date"
                className="input input-bordered input-sm"
                value={form.closingDate}
                onChange={(e) => setForm({ ...form, closingDate: e.target.value })}
              />
            </label>
            <label className="form-control">
              <span className="label-text text-xs">Transaction type *</span>
              <select
                required
                className="select select-bordered select-sm"
                value={form.dealType}
                onChange={(e) => setForm({ ...form, dealType: e.target.value })}
              >
                <option value="" disabled>
                  Select…
                </option>
                <option value="purchase">Purchase</option>
                <option value="sale">Sale</option>
                <option value="refinance">Refinance</option>
              </select>
            </label>
          </div>
          <div>
            <span className="label-text text-xs block mb-1">Appointment type *</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="appointmentType"
                  checked={form.appointmentType === "in_person"}
                  onChange={() => setForm({ ...form, appointmentType: "in_person" })}
                />
                In person{availability ? ` (${availability.officeAddress})` : ""}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="appointmentType"
                  checked={form.appointmentType === "virtual"}
                  onChange={() => setForm({ ...form, appointmentType: "virtual" })}
                />
                Virtual (Google Meet)
              </label>
            </div>
          </div>
          <label className="form-control">
            <span className="label-text text-xs">Additional guest emails (comma separated, optional)</span>
            <input
              className="input input-bordered input-sm"
              value={form.extraGuestsText}
              onChange={(e) => setForm({ ...form, extraGuestsText: e.target.value })}
            />
          </label>

          {error && <p className="text-sm text-error">{error}</p>}

          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "Booking…" : "Schedule Event"}
          </button>
        </form>
      )}
    </div>
  );
}
