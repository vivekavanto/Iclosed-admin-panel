"use client";

import React, { useState } from "react";
import { Info } from "lucide-react";
import {
  DISCLAIMERS,
  LINE_TOOLTIPS,
  type Statement,
  type StatementLine,
} from "@/lib/closingCosts";
import { formatCurrency } from "@/lib/formatCurrency";

// The client-facing "Estimated Statement of Account".
//
// Driven entirely by a Statement object, so it renders a live computation and a
// frozen `line_items` snapshot identically — there is no conditional logic here
// for cash purchases, Toronto, or first-time-buyer rebates. computeStatement
// omits the lines that don't apply, so this just draws what it is given.

const BRAND = "#C10007";

/** Hover/focus info bubble. Every line has one — it is how the client
 *  understands what they are being charged for. */
const InfoTip: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center align-middle">
      <button
        type="button"
        aria-label={`What is ${label}?`}
        className="ml-1.5 text-gray-300 hover:text-[#C10007] focus:text-[#C10007] focus:outline-none"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Tap-to-toggle so the tooltip is reachable on touch devices too.
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <Info size={12} />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 bottom-full z-20 mb-2 w-64 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-[11px] font-normal leading-snug text-white shadow-xl"
        >
          {text}
        </span>
      )}
    </span>
  );
};

const Line: React.FC<{ line: StatementLine }> = ({ line }) => {
  const tip = LINE_TOOLTIPS[line.key];
  const negative = line.amount < 0;
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div
          className={`flex items-center text-[13px] leading-snug ${
            negative ? "text-[#C10007]" : "text-gray-800"
          }`}
        >
          <span>{line.label}</span>
          {line.badge && (
            <span className="ml-2 shrink-0 rounded bg-orange-50 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-orange-700 ring-1 ring-orange-200">
              {line.badge}
            </span>
          )}
          {tip && <InfoTip text={tip} label={line.label} />}
        </div>
        {line.sublabel && (
          <div className="mt-0.5 text-[11px] italic text-gray-400">{line.sublabel}</div>
        )}
      </div>
      <div
        className={`shrink-0 text-[13px] tabular-nums ${
          negative ? "text-[#C10007]" : "text-gray-900"
        }`}
      >
        {formatCurrency(line.amount)}
      </div>
    </div>
  );
};

export interface ClosingCostStatementProps {
  statement: Statement;
  /** Small caption under the heading, e.g. "Draft — not yet issued". */
  caption?: string;
  /**
   * Shown as a chip on the "Legal & Admin Fees" group heading — the acting
   * firm's `firm_badge`. Null hides the chip.
   */
  firmBadge?: string | null;
  /** From the statement type; defaults to the draft wording. */
  heading?: string;
  /**
   * The bolded lead line above the standing legal text, from the statement
   * type. Without this a "final account" would still print the draft's
   * "this is an estimate" wording. DISCLAIMERS[1..] applies to both and is
   * never overridden.
   */
  disclaimerIntro?: string;
  /** Set false to hide the disclaimer block (e.g. when it is rendered elsewhere). */
  showDisclaimers?: boolean;
}

const ClosingCostStatement: React.FC<ClosingCostStatementProps> = ({
  statement,
  caption,
  firmBadge = null,
  heading = "ESTIMATED STATEMENT OF ACCOUNT",
  disclaimerIntro,
  showDisclaimers = true,
}) => {
  const b = statement.balance;

  return (
    <div>
      <h2 className="text-sm font-bold tracking-wide text-gray-900">{heading}</h2>
      {caption && <p className="mt-1 text-[11px] text-gray-400">{caption}</p>}

      <div className="mt-5 space-y-5">
        {statement.groups.map((group) => (
          <div key={group.key}>
            <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
              <h3
                className="text-[11px] font-bold tracking-wide"
                style={{ color: BRAND }}
              >
                {group.title.toUpperCase()}
              </h3>
              {/* Category subtotals are intentionally NOT shown — the statement
                  stays clean and only the grand total is emphasised. */}
              {group.key === "legal" && firmBadge && (
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-gray-600">
                  {firmBadge}
                </span>
              )}
            </div>
            <div className="mt-1.5 divide-y divide-gray-50">
              {group.lines.map((line) => (
                <Line key={line.key} line={line} />
              ))}
            </div>
          </div>
        ))}

        {/* HST gets its own line, outside the four groups. */}
        <div className="border-t border-dashed border-gray-200 pt-3">
          <Line
            line={{ key: "hst", label: statement.hst.label, amount: statement.hst.amount }}
          />
        </div>
      </div>

      {/* Total */}
      <div
        className="mt-5 flex items-center justify-between gap-4 rounded-lg px-4 py-3 text-white"
        style={{ backgroundColor: BRAND }}
      >
        <span className="text-[13px] font-bold">
          Total legal fees, taxes &amp; disbursements
        </span>
        <span className="shrink-0 text-lg font-bold tabular-nums">
          {formatCurrency(statement.total)}
        </span>
      </div>

      {/* Property tax adjustment — a Statement of Adjustments item, so it sits
          outside the total above and is added to the balance separately. */}
      {statement.propertyTax && (
        <div className="mt-5">
          <h3 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
            PROPERTY TAX
          </h3>
          <div className="mt-2 border-t border-gray-100 pt-2">
            <Line line={statement.propertyTax} />
          </div>
        </div>
      )}

      {/* Balance due on closing */}
      <div
        className="mt-4 rounded-lg border border-dashed px-4 py-4"
        style={{ borderColor: BRAND }}
      >
        <p className="text-[10px] font-bold tracking-wide" style={{ color: BRAND }}>
          FUNDS REQUIRED ON CLOSING
        </p>
        <dl className="mt-2.5 space-y-1.5 text-[12px]">
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">Purchase price</dt>
            <dd className="tabular-nums text-gray-700">
              {formatCurrency(b.purchasePrice)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">less deposit already paid</dt>
            <dd className="tabular-nums text-gray-700">
              {formatCurrency(-b.depositPaid)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">less mortgage advance from your lender</dt>
            <dd className="tabular-nums text-gray-700">
              {formatCurrency(-b.mortgageAmount)}
            </dd>
          </div>
          {b.propertyTaxAdjustment !== 0 && (
            <div className="flex justify-between gap-4">
              {/* Signed, so a seller in arrears reads as a credit, not a charge. */}
              <dt className="text-gray-500">
                {b.propertyTaxAdjustment > 0
                  ? "plus property tax adjustment"
                  : "less property tax credit"}
              </dt>
              <dd className="tabular-nums text-gray-700">
                {formatCurrency(b.propertyTaxAdjustment)}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">plus total closing costs</dt>
            <dd className="tabular-nums text-gray-700">
              + {formatCurrency(b.closingCosts)}
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex items-center justify-between gap-4 border-t border-gray-100 pt-3">
          <span className="flex items-center text-[13px] font-bold" style={{ color: BRAND }}>
            Estimated balance due on closing
            <InfoTip
              text={LINE_TOOLTIPS.balance_due}
              label="the estimated balance due on closing"
            />
          </span>
          <span
            className="shrink-0 text-xl font-bold tabular-nums"
            style={{ color: BRAND }}
          >
            {formatCurrency(b.balanceDue)}
          </span>
        </div>
      </div>

      {showDisclaimers && (
        <div className="mt-4 space-y-1.5 text-[10px] leading-relaxed text-gray-400">
          <p className="font-bold text-gray-600">
            {disclaimerIntro ?? DISCLAIMERS[0]}
          </p>
          {DISCLAIMERS.slice(1).map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      )}
    </div>
  );
};

export default ClosingCostStatement;
