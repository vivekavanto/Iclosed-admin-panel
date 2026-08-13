"use client";

import React, { useState } from "react";
import {
  DISCLAIMERS,
  LINE_TOOLTIPS,
  type Statement,
  type StatementLine,
} from "@/lib/closingCosts";
import type { StatementTypeConfig } from "@/lib/closingCostSettings";
import { formatCurrency } from "@/lib/formatCurrency";
import { BalanceRow, signedCurrency } from "./fields";

// The right-hand "Closing costs" card — the document half of the calculator.
//
// Extracted from ClosingCostCalculator.tsx so /admin/calculator and a deal's
// closing-cost page render the SAME statement from the same component. The two
// pages differ in what they can DO with the figures (a deal can issue and email
// them); what the figures look like is not allowed to differ.

export interface StatementCardProps {
  statement: Statement;
  /** The firm's brand colour — the same accent the letterhead and PDF use. */
  accent: string;
  /** A draft is provisional; a final account is confirmed. Drives the wording. */
  isDraft: boolean;
  statementType: StatementTypeConfig | null;
}

const StatementCard: React.FC<StatementCardProps> = ({
  statement,
  accent,
  isDraft,
  statementType,
}) => {
  /** Key of the statement line whose tooltip is showing; only ever one. */
  const [tip, setTip] = useState<string | null>(null);

  const tipHandlers = (key: string) => ({
    onMouseEnter: () => setTip(key),
    onMouseLeave: () => setTip((k) => (k === key ? null : k)),
    onFocus: () => setTip(key),
    onBlur: () => setTip((k) => (k === key ? null : k)),
  });

  /** One "label … amount" row, with its info bubble. */
  const renderLine = (line: StatementLine, muted = false) => {
    const copy = LINE_TOOLTIPS[line.key] ?? null;
    // A "not final yet" marker. The title premium carries its own badge from
    // the calculation (it disappears the moment the real FCT quote is pasted in);
    // the rest are only provisional while the statement is still a draft.
    // The engine decides which lines are provisional, so the screen, the PDF
    // and a frozen snapshot always agree. See CALC_VERSION 7.
    const badge = line.badge ?? null;

    return (
      <div
        key={line.key}
        className={`flex items-baseline justify-between gap-3.5 py-1.5 text-[13.5px] ${
          muted ? "text-gray-500" : "text-gray-900"
        }`}
      >
        <span className="inline-flex max-w-[76%] flex-wrap items-center">
          {line.label}
          {badge && (
            <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-700">
              {badge}
            </span>
          )}
          {copy && (
            <span className="relative ml-1.5 inline-flex">
              <span
                tabIndex={0}
                role="note"
                aria-label={copy}
                {...tipHandlers(line.key)}
                className="flex h-[15px] w-[15px] cursor-help items-center justify-center rounded-full text-[10px] font-bold"
                style={{ backgroundColor: `${accent}1a`, color: accent }}
              >
                i
              </span>
              {tip === line.key && (
                <span className="absolute bottom-6 left-1/2 z-20 w-[250px] -translate-x-1/2 rounded-[10px] bg-gray-900 px-3 py-2.5 text-[11.5px] font-normal leading-relaxed text-white shadow-xl">
                  {copy}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="whitespace-nowrap tabular-nums">
          {formatCurrency(line.amount)}
        </span>
      </div>
    );
  };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white px-7 py-6 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-gray-200 pb-3.5">
        <div>
          <h2 className="text-[17px] font-bold tracking-tight text-gray-900">
            Closing costs
          </h2>
          <p className="mt-0.5 text-[12.5px] text-gray-500">
            {isDraft
              ? "Draft estimate — for planning only, before your lender's instructions arrive."
              : "Final account — figures confirmed against your lender's mortgage instructions."}
          </p>
        </div>
      </div>

      {/* Rendered from the computed groups, so a line that does not apply —
          no mortgage registration on a cash deal, no municipal tax outside
          Toronto — is absent rather than shown as zero. */}
      {statement.groups.map((group) => (
        <div key={group.key}>
          <h3
            className="mb-1 mt-5 border-b border-gray-100 pb-1.5 text-[11px] font-bold uppercase tracking-[0.11em]"
            style={{ color: accent }}
          >
            {group.title}
          </h3>
          {group.lines.map((line) =>
            renderLine(line, line.amount < 0 || line.key.startsWith("rebate_")),
          )}
          {group.key === "legal" && (
            <div className="mt-1.5 border-t border-dashed border-gray-200 pt-2">
              {renderLine({
                key: "hst",
                label: "HST",
                amount: statement.hst.amount,
              })}
            </div>
          )}
        </div>
      ))}

      {statement.propertyTax && (
        <div>
          <h3
            className="mb-1 mt-5 border-b border-gray-100 pb-1.5 text-[11px] font-bold uppercase tracking-[0.11em]"
            style={{ color: accent }}
          >
            Adjustments
          </h3>
          {renderLine(statement.propertyTax)}
        </div>
      )}

      <div className="mt-2 flex items-baseline justify-between gap-3.5 border-t border-gray-900 pt-2.5">
        <span className="text-[13.5px] font-semibold text-gray-900">
          Total closing costs
        </span>
        <span className="text-[14.5px] font-semibold tabular-nums text-gray-900">
          {formatCurrency(statement.total)}
        </span>
      </div>

      {/* Funds needed — the number the client actually acts on. */}
      <div
        className="mt-3.5 rounded-xl border p-4.5 px-5 py-4"
        style={{ borderColor: `${accent}33`, backgroundColor: `${accent}0a` }}
      >
        <div
          className="mb-2 text-[11px] font-bold uppercase tracking-[0.11em]"
          style={{ color: accent }}
        >
          Funds you&apos;ll need on closing
        </div>
        <BalanceRow
          label="Purchase price"
          value={formatCurrency(statement.balance.purchasePrice)}
        />
        <BalanceRow
          muted
          label="less deposit already paid"
          value={signedCurrency(-statement.balance.depositPaid)}
        />
        <BalanceRow
          muted
          label="less mortgage advance from your lender"
          value={signedCurrency(-statement.balance.mortgageAmount)}
        />
        {statement.balance.propertyTaxAdjustment !== 0 && (
          <BalanceRow
            label="plus adjustments (above)"
            value={signedCurrency(statement.balance.propertyTaxAdjustment)}
          />
        )}
        <BalanceRow
          label="plus closing costs (above)"
          value={signedCurrency(statement.balance.closingCosts)}
        />
        <div
          className="mt-2.5 flex items-baseline justify-between border-t pt-3"
          style={{ borderColor: `${accent}33` }}
        >
          <span className="text-[14px] font-bold text-gray-900">
            Estimated balance due on closing
          </span>
          <span
            className="text-[22px] font-bold tabular-nums"
            style={{ color: accent }}
          >
            {formatCurrency(statement.balance.balanceDue)}
          </span>
        </div>
      </div>

      <p className="mt-3.5 border-t border-gray-200 pt-3.5 text-[11.5px] leading-relaxed text-gray-500">
        <strong className="text-gray-600">
          {statementType?.disclaimer_intro || DISCLAIMERS[0]}
        </strong>{" "}
        {DISCLAIMERS.slice(1).join(" ")}
        {statementType?.footer_note ? ` ${statementType.footer_note}` : ""}
      </p>
    </section>
  );
};

export default StatementCard;
