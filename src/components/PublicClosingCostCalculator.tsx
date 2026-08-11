"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Download, Loader2, Mail, Send } from "lucide-react";
import {
  DEFAULT_RATES,
  DISCLAIMERS,
  LINE_TOOLTIPS,
  computeStatement,
  ratesFromConfigRow,
  type StatementLine,
} from "@/lib/closingCosts";
import { formatCurrency, parseAmountInput } from "@/lib/formatCurrency";

// The PUBLIC closing-cost estimator rendered at /calculator.
//
// ── How this differs from ClosingCostCalculator.tsx ────────────────────────
// That one is the staff surface for ONE file: it picks the firm, picks the
// statement flavour, overrides individual fees, saves a draft, issues to the
// client and emails the frozen snapshot. None of that belongs to a stranger with
// a link, so none of it is here. What is left is the part a buyer actually
// wants: type three numbers, answer two questions, see what closing costs.
//
// The two share the ONE thing that must never fork — `computeStatement`. This
// page runs it in the browser on every keystroke, and /api/calculator/pdf runs
// the same function server-side from the same settings row, so the PDF a visitor
// downloads cannot disagree with the figure that persuaded them to download it.
//
// Nothing is saved. No lead is created, no estimate row is written, the typed
// figures never leave the browser unless the visitor asks for a PDF or an email.

const FALLBACK_BRAND = "#C10007";

/** The shape /api/calculator/config returns. */
interface CalculatorConfig {
  rates: Record<string, unknown>;
  firm: Record<string, unknown>;
  logo_url: string | null;
  property_tax_default: number | null;
  statement_type: { label: string; disclaimer_intro: string; footer_note: string };
  disclaimers: string[];
}

interface FormState {
  price: string;
  deposit: string;
  mortgage: string;
  isToronto: boolean;
  isFirstTimeBuyer: boolean;
}

const EMPTY_FORM: FormState = {
  price: "",
  deposit: "",
  mortgage: "",
  isToronto: false,
  isFirstTimeBuyer: false,
};

type Toast = { message: string; type: "success" | "error" } | null;

const PublicClosingCostCalculator: React.FC<{
  /**
   * The firm's rate card, resolved server-side by the page so the first paint
   * already shows real figures. Null only if that read failed, in which case the
   * effect below falls back to fetching it from the browser.
   */
  initialConfig?: CalculatorConfig | null;
}> = ({ initialConfig = null }) => {
  const [config, setConfig] = useState<CalculatorConfig | null>(initialConfig);
  const [configError, setConfigError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // Collapsed on arrival. The figure a visitor came for is the balance due; the
  // nine-line itemisation is the answer to "why", which is a question they only
  // ask after they have seen the number.
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailName, setEmailName] = useState("");
  const [emailing, setEmailing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  /** Key of the line whose tooltip is showing; only ever one. */
  const [tip, setTip] = useState<string | null>(null);

  // No "Prepared <date>" on this page. A date stamp belongs on the PDF, which is
  // a document someone may keep and later need to place in time; on a live
  // calculator it dates nothing — the figures change as you type — and it made
  // the page read as an issued statement rather than a tool. The PDF still
  // carries it, stamped server-side at generation.

  const showToast = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 4000);
    },
    [],
  );

  // ─────────────────────────────── config ───────────────────────────────

  useEffect(() => {
    // The page already supplied it. Re-fetching would cost a round trip to
    // re-learn what is on screen — and ISR keeps that copy at most a minute old.
    if (initialConfig) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/calculator/config");
        const data = await res.json();
        if (!res.ok || !data?.success) throw new Error("config");
        if (!cancelled) setConfig(data as CalculatorConfig);
      } catch {
        // The page still works — `rates` falls back to DEFAULT_RATES, which
        // mirrors the settings defaults — but the figures are no longer
        // guaranteed to be the firm's current ones, so say so rather than
        // quietly quoting from a fallback.
        if (!cancelled) {
          setConfigError(
            "We could not load our current fee schedule, so these figures may be out of date. Please refresh, or contact us for an exact quote.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialConfig]);

  // ──────────────────────────── computation ───────────────────────────

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const rates = useMemo(
    () => (config ? ratesFromConfigRow(config.rates) : DEFAULT_RATES),
    [config],
  );

  const statement = useMemo(
    () =>
      computeStatement(
        {
          price: parseAmountInput(form.price) ?? 0,
          deposit: parseAmountInput(form.deposit) ?? 0,
          mortgage: parseAmountInput(form.mortgage) ?? 0,
          isToronto: form.isToronto,
          isFirstTimeBuyer: form.isFirstTimeBuyer,
          // The firm's planning figure, exactly as the server applies it. A
          // visitor cannot know their own Statement of Adjustments, and omitting
          // it would understate the funds they need — the direction that hurts.
          propertyTaxAdjustment: config?.property_tax_default ?? null,
          // A public estimate is always a draft, so every provisional line keeps
          // its ESTIMATE badge.
          isFinalAccount: false,
        },
        rates,
      ),
    [form, rates, config],
  );

  /** The exact body both the PDF and the email routes are sent. */
  const buildBody = useCallback(
    () => ({
      purchasePrice: parseAmountInput(form.price) ?? 0,
      depositPaid: parseAmountInput(form.deposit) ?? 0,
      mortgageAmount: parseAmountInput(form.mortgage) ?? 0,
      isToronto: form.isToronto,
      isFirstTimeBuyer: form.isFirstTimeBuyer,
    }),
    [form],
  );

  const hasPrice = (parseAmountInput(form.price) ?? 0) > 0;

  // ───────────────────────────── actions ─────────────────────────────

  const handleDownload = async () => {
    if (!hasPrice) {
      showToast("Enter a purchase price first.", "error");
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch("/api/calculator/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildBody(), clientName: emailName.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not generate the PDF.");
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "estimated-closing-costs.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not generate the PDF.",
        "error",
      );
    } finally {
      setDownloading(false);
    }
  };

  const handleEmail = async () => {
    if (!hasPrice) {
      showToast("Enter a purchase price first.", "error");
      return;
    }
    const to = emailTo.trim();
    if (!to) {
      showToast("Enter the email address to send it to.", "error");
      return;
    }
    setEmailing(true);
    try {
      const res = await fetch("/api/calculator/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          to,
          clientName: emailName.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not send the email.");
      }
      showToast(`Sent to ${data.sent_to} — check your inbox.`);
      setEmailOpen(false);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not send the email.",
        "error",
      );
    } finally {
      setEmailing(false);
    }
  };

  // ────────────────────────────── render ──────────────────────────────

  const firm = config?.firm ?? {};
  const accent = String(firm.brand_color || FALLBACK_BRAND);
  const firmName = String(firm.firm_name || "iClosed");
  const logoUrl = config?.logo_url ?? "";
  const disclaimerIntro =
    config?.statement_type.disclaimer_intro || DISCLAIMERS[0];
  const footerNote = config?.statement_type.footer_note || "";

  const tipHandlers = (key: string) => ({
    onMouseEnter: () => setTip(key),
    onMouseLeave: () => setTip((k) => (k === key ? null : k)),
    onFocus: () => setTip(key),
    onBlur: () => setTip((k) => (k === key ? null : k)),
  });

  /** One "label … amount" row of the breakdown, with its info bubble. */
  const renderLine = (line: StatementLine, muted = false) => {
    const copy = LINE_TOOLTIPS[line.key] ?? null;
    return (
      <div
        key={line.key}
        className={`flex items-baseline justify-between gap-3 py-1.5 text-[13px] ${
          muted ? "text-gray-500" : "text-gray-800"
        }`}
      >
        <span className="inline-flex max-w-[74%] flex-wrap items-center">
          {line.label}
          {line.badge && (
            <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">
              {line.badge}
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
                <span className="absolute bottom-6 left-1/2 z-20 w-[240px] -translate-x-1/2 rounded-[10px] bg-gray-900 px-3 py-2.5 text-[11.5px] font-normal leading-relaxed text-white shadow-xl">
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
    <div className="min-h-screen bg-gray-50/70 font-sans text-slate-900">
      {toast && (
        <div
          role="status"
          className={`fixed left-1/2 top-5 z-50 max-w-[92vw] -translate-x-1/2 rounded-lg px-4 py-3 text-sm text-white shadow-lg sm:left-auto sm:right-6 sm:translate-x-0 ${
            toast.type === "error" ? "bg-red-600" : "bg-gray-900"
          }`}
        >
          {toast.message}
        </div>
      )}

      <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 lg:px-8">
        {/* ── Letterhead ── every value from the firm's profile in Settings. */}
        <header className="border-b border-gray-200 pb-4">
          <div className="flex flex-col gap-1.5">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={firmName}
                className="h-[30px] w-auto object-contain"
              />
            ) : (
              <span className="text-2xl font-bold leading-none tracking-tight text-gray-900">
                {firmName}
              </span>
            )}
            <div className="text-[12.5px] leading-relaxed text-gray-500">
              {String(firm.firm_address || "")}
              {firm.firm_phone ? (
                <>
                  <br />
                  Tel: {String(firm.firm_phone)}
                  {firm.firm_fax ? ` · Fax: ${String(firm.firm_fax)}` : ""}
                  {firm.firm_hst_number
                    ? ` · HST # ${String(firm.firm_hst_number)}`
                    : ""}
                </>
              ) : null}
            </div>
          </div>
        </header>

        <div className="mb-5 mt-6 max-w-[720px]">
          <h1 className="text-[30px] font-bold leading-tight tracking-tight text-gray-900">
            Closing cost estimate
          </h1>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-gray-600">
            Enter your purchase price, the deposit you have already paid, and your
            mortgage amount, and we&apos;ll estimate how much you&apos;ll need to bring
            to your closing.
          </p>
        </div>

        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3.5">
          <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-amber-600 text-xs font-bold text-white">
            !
          </span>
          <p className="text-[13px] leading-relaxed text-amber-900">
            <strong className="font-bold">{disclaimerIntro}</strong> Once we act for
            you on your purchase, your exact figures are calculated from your
            lender&apos;s mortgage instructions and confirmed in a signed Statement of
            Account before closing.
          </p>
        </div>

        {configError && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] leading-relaxed text-red-900">
            {configError}
          </div>
        )}

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          {/* ────────────────────────── Your numbers ────────────────────────── */}
          <section className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:sticky lg:top-6">
            <div>
              <h2
                className="text-[12px] font-bold uppercase tracking-[0.09em]"
                style={{ color: accent }}
              >
                Your numbers
              </h2>
              <p className="mt-0.5 text-[12.5px] text-gray-500">
                A few details from your purchase agreement.
              </p>
            </div>

            <BigMoney
              id="cc-price"
              label="Purchase price"
              value={form.price}
              accent={accent}
              onChange={(v) => update("price", v)}
            />
            <BigMoney
              id="cc-deposit"
              label="Deposit already paid"
              value={form.deposit}
              accent={accent}
              onChange={(v) => update("deposit", v)}
            />
            <BigMoney
              id="cc-mortgage"
              label="Mortgage amount"
              value={form.mortgage}
              accent={accent}
              hint="Enter 0 if this is a cash deal."
              onChange={(v) => update("mortgage", v)}
            />

            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-semibold text-gray-900">
                Where is the property?
              </span>
              <div className="flex flex-wrap gap-2">
                <ChoiceButton
                  label="Elsewhere in Ontario"
                  active={!form.isToronto}
                  accent={accent}
                  onClick={() => update("isToronto", false)}
                />
                <ChoiceButton
                  label="City of Toronto"
                  active={form.isToronto}
                  accent={accent}
                  onClick={() => update("isToronto", true)}
                />
              </div>
              <span className="text-[11.5px] text-gray-500">
                Toronto charges a second, municipal land transfer tax.
              </span>
            </div>

            <button
              type="button"
              onClick={() => update("isFirstTimeBuyer", !form.isFirstTimeBuyer)}
              className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left text-[13px] font-semibold transition ${
                form.isFirstTimeBuyer
                  ? "bg-red-50/40"
                  : "border-gray-200 hover:bg-gray-50"
              }`}
              style={form.isFirstTimeBuyer ? { borderColor: accent } : undefined}
              aria-pressed={form.isFirstTimeBuyer}
            >
              <span
                className="mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-md border text-[11px] font-bold text-white"
                style={
                  form.isFirstTimeBuyer
                    ? { backgroundColor: accent, borderColor: accent }
                    : { borderColor: "#d1d5db" }
                }
              >
                {form.isFirstTimeBuyer ? "✓" : ""}
              </span>
              <span className="leading-relaxed">
                I am a first-time home buyer
                <span className="block text-[11.5px] font-normal text-gray-500">
                  Applies the land transfer tax rebate — up to{" "}
                  {formatCurrency(rates.rebateOntarioMax, { cents: false })} in
                  Ontario, plus{" "}
                  {formatCurrency(rates.rebateTorontoMax, { cents: false })} in
                  Toronto.
                </span>
              </span>
            </button>

            <div className="flex flex-wrap gap-2.5 pt-0.5">
              <button
                type="button"
                onClick={() => setEmailOpen((o) => !o)}
                aria-expanded={emailOpen}
                className="min-w-[150px] flex-1 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[13.5px] font-semibold text-gray-800 transition hover:border-gray-300"
              >
                <Mail size={14} className="mr-1.5 inline" />
                Email it to me
              </button>
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                className="inline-flex min-w-[150px] flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-3 text-[13.5px] font-semibold text-white transition disabled:opacity-50"
                style={{ backgroundColor: accent }}
              >
                {downloading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                Download PDF
              </button>
            </div>

            {emailOpen && (
              <div className="flex flex-col gap-2 rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-3.5 py-3">
                <label
                  htmlFor="cc-name"
                  className="text-[11px] font-semibold text-gray-600"
                >
                  Your name (optional)
                </label>
                <input
                  id="cc-name"
                  type="text"
                  autoComplete="name"
                  value={emailName}
                  onChange={(e) => setEmailName(e.target.value)}
                  placeholder="Jane Doe"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13.5px] outline-none placeholder:text-gray-300"
                />
                <label
                  htmlFor="cc-email"
                  className="mt-1 text-[11px] font-semibold text-gray-600"
                >
                  Email address
                </label>
                <input
                  id="cc-email"
                  type="email"
                  autoComplete="email"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder="you@email.com"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13.5px] outline-none placeholder:text-gray-300"
                />
                <button
                  type="button"
                  onClick={handleEmail}
                  disabled={emailing}
                  className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  style={{ backgroundColor: accent }}
                >
                  {emailing ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Send size={13} />
                  )}
                  Send my estimate
                </button>
                <span className="text-[10.5px] leading-snug text-gray-400">
                  We&apos;ll email you this estimate with the full breakdown attached
                  as a PDF. Your figures are not saved.
                </span>
              </div>
            )}
          </section>

          {/* ─────────────────────────── The estimate ─────────────────────────── */}
          <section className="rounded-2xl border border-gray-200 bg-white px-5 py-6 shadow-sm sm:px-7">
            <div className="border-b border-gray-200 pb-3.5">
              <h2 className="text-[17px] font-bold tracking-tight text-gray-900">
                Estimated closing costs
              </h2>
              <p className="mt-0.5 text-[12.5px] text-gray-500">
                An approximate figure — we&apos;ll confirm exact amounts once we act
                on your purchase.
              </p>
            </div>

            {/* The one number the whole page exists to give. */}
            <div className="mt-5">
              <div
                className="text-[11px] font-bold uppercase tracking-[0.11em]"
                style={{ color: accent }}
              >
                Funds you&apos;ll need on closing
              </div>
              {/* Always the computed figure, never a placeholder dash — even on
                  an untouched form. With no price the engine still produces a
                  real answer: the fees that do not scale with price (legal,
                  admin, Teraview, the Sheriff's searches, registration) plus
                  HST. Showing that on arrival makes the page demonstrate itself,
                  and the number visibly moves the moment a price is typed. A
                  dash makes the calculator look broken before it is used. */}
              <div
                className="mt-1 text-[34px] font-bold leading-tight tabular-nums sm:text-[40px]"
                style={{ color: accent }}
              >
                {formatCurrency(statement.balance.balanceDue)}
              </div>
              <p className="mt-1 text-[12px] text-gray-500">
                Certified funds due to your lawyer on closing day.
              </p>
            </div>

            <div className="mt-4 border-t border-gray-100 pt-3">
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
                  label="plus adjustments (est.)"
                  value={signedCurrency(statement.balance.propertyTaxAdjustment)}
                />
              )}
              <BalanceRow
                label="plus closing costs"
                value={signedCurrency(statement.balance.closingCosts)}
              />
            </div>

            {/* ── The itemised breakdown ── */}
            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3">
              <button
                type="button"
                onClick={() => setBreakdownOpen((o) => !o)}
                aria-expanded={breakdownOpen}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="text-[12px] font-bold text-gray-800">
                  See the full breakdown
                </span>
                <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-gray-500">
                  {breakdownOpen ? "Collapse" : "Expand"}
                  <ChevronDown
                    size={12}
                    className={`transition-transform ${breakdownOpen ? "rotate-180" : ""}`}
                  />
                </span>
              </button>

              {breakdownOpen && (
                <div className="mt-1">
                  {/* Rendered from the computed groups, so a line that does not
                      apply — no mortgage registration on a cash deal, no
                      municipal tax outside Toronto — is absent rather than shown
                      as zero. */}
                  {statement.groups.map((group) => (
                    <div key={group.key}>
                      <h3
                        className="mb-1 mt-4 border-b border-gray-200 pb-1.5 text-[10.5px] font-bold uppercase tracking-[0.11em]"
                        style={{ color: accent }}
                      >
                        {group.title}
                      </h3>
                      {group.lines.map((line) =>
                        renderLine(
                          line,
                          line.amount < 0 || line.key.startsWith("rebate_"),
                        ),
                      )}
                      {group.key === "legal" && (
                        <div className="mt-1.5 border-t border-dashed border-gray-300 pt-2">
                          {renderLine({
                            key: "hst",
                            label: `HST @ ${(rates.hstRate * 100).toFixed(0)}% on taxable fees & disbursements`,
                            amount: statement.hst.amount,
                          })}
                        </div>
                      )}
                    </div>
                  ))}

                  {statement.propertyTax && (
                    <div>
                      <h3
                        className="mb-1 mt-4 border-b border-gray-200 pb-1.5 text-[10.5px] font-bold uppercase tracking-[0.11em]"
                        style={{ color: accent }}
                      >
                        Adjustments
                      </h3>
                      {renderLine(statement.propertyTax)}
                    </div>
                  )}

                  <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-gray-900 pt-2.5">
                    <span className="text-[13px] font-semibold text-gray-900">
                      Total closing costs
                    </span>
                    <span className="text-[14px] font-semibold tabular-nums text-gray-900">
                      {formatCurrency(statement.total)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <p className="mt-4 border-t border-gray-200 pt-3.5 text-[11px] leading-relaxed text-gray-500">
              <strong className="text-gray-600">{disclaimerIntro}</strong>{" "}
              {DISCLAIMERS.slice(1).join(" ")}
              {footerNote ? ` ${footerNote}` : ""}
            </p>
          </section>
        </div>

        <footer className="mt-8 border-t border-gray-200 pt-4 text-center text-[11.5px] leading-relaxed text-gray-400">
          {firmName}
          {firm.firm_address ? ` · ${String(firm.firm_address)}` : ""}
          <br />
          This calculator provides an estimate only and does not create a
          solicitor-client relationship.
        </footer>
      </div>
    </div>
  );
};

/** "+ $1,200.00" / "– $50,000.00" / "—" for zero. */
function signedCurrency(n: number): string {
  const v = Math.round(n * 100) / 100;
  if (v === 0) return "—";
  return `${v < 0 ? "– " : "+ "}${formatCurrency(Math.abs(v))}`;
}

const BalanceRow: React.FC<{ label: string; value: string; muted?: boolean }> = ({
  label,
  value,
  muted,
}) => (
  <div
    className={`flex justify-between gap-3 py-1 text-[13px] ${
      muted ? "text-gray-500" : "text-gray-800"
    }`}
  >
    <span>{label}</span>
    <span className="whitespace-nowrap tabular-nums">{value}</span>
  </div>
);

const ChoiceButton: React.FC<{
  label: string;
  active: boolean;
  accent: string;
  onClick: () => void;
}> = ({ label, active, accent, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-lg border px-3 py-2 text-[12.5px] font-semibold transition ${
      active ? "bg-red-50/50" : "border-gray-200 text-gray-600 hover:bg-gray-50"
    }`}
    style={active ? { borderColor: accent, color: accent } : undefined}
  >
    {label}
  </button>
);

/**
 * One of the three headline amounts.
 *
 * Grouping separators are applied on BLUR, not on every keystroke: reformatting
 * mid-edit moves the caret, so typing "1080000" would fight the cursor at every
 * thousand. While the field has focus it holds exactly what was typed.
 */
const BigMoney: React.FC<{
  id: string;
  label: string;
  value: string;
  accent: string;
  hint?: string;
  onChange: (value: string) => void;
}> = ({ id, label, value, accent, hint, onChange }) => {
  const [focused, setFocused] = useState(false);

  const parsed = parseAmountInput(value);
  const display =
    !focused && parsed !== null ? parsed.toLocaleString("en-CA") : value;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-gray-900">
        {label}
      </label>
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-3.5 font-semibold text-gray-400">
          $
        </span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={display}
          // A PLACEHOLDER zero, not a value. It reads as "0" on an untouched
          // form — matching the figure the statement is computing from — but the
          // field is genuinely empty, so the first keystroke replaces it instead
          // of appending to it and turning 1080000 into 01080000.
          placeholder="0"
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-gray-200 bg-gray-50/40 py-3 pl-7 pr-3.5 text-base font-semibold tabular-nums text-gray-900 outline-none transition placeholder:text-gray-400 placeholder:font-semibold focus:bg-white"
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.style.borderColor = accent;
            e.currentTarget.style.boxShadow = `0 0 0 3px ${accent}22`;
          }}
          onBlur={(e) => {
            setFocused(false);
            e.currentTarget.style.borderColor = "";
            e.currentTarget.style.boxShadow = "";
          }}
        />
      </div>
      {hint && <span className="text-[11.5px] text-gray-500">{hint}</span>}
    </div>
  );
};

export default PublicClosingCostCalculator;
