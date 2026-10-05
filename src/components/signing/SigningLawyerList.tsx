"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";

interface LawyerOption {
  initials: string;
  fullName: string;
}

export default function SigningLawyerList() {
  const [lawyers, setLawyers] = useState<LawyerOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/signing/lawyers");
      const json = await res.json();
      if (!cancelled && json.success) setLawyers(json.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-xl mx-auto p-6 sm:p-8">
      <h1 className="text-xl font-semibold mb-1">Book a Signing Appointment</h1>
      <p className="text-sm text-base-content/60 mb-6">Choose who you're signing with.</p>

      {lawyers === null ? (
        <p className="text-sm text-base-content/60">Loading…</p>
      ) : lawyers.length === 0 ? (
        <p className="text-sm text-base-content/60">
          No lawyers are currently taking signing appointments. Please contact the office.
        </p>
      ) : (
        <div className="space-y-2">
          {lawyers.map((l) => (
            <Link
              key={l.initials}
              href={`/signing/${l.initials}`}
              className="card bg-base-200 p-4 hover:bg-base-300 flex-row items-center justify-between"
            >
              <span className="font-medium">{l.fullName}</span>
              <span className="text-sm text-base-content/60">Select →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
