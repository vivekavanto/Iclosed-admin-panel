export interface MortgageTaskAnswer {
  field_label: string | null;
  value: unknown;
}

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

// 0 = no mortgage; null = unanswered.
export function mortgageFromAnswers(answers: readonly MortgageTaskAnswer[]): number | null {
  if (answers.some((a) => lower(a.field_label).startsWith("are you getting a mortgage") && lower(a.value) === "no")) {
    return 0;
  }
  const raw = lower(answers.find((a) => lower(a.field_label) === "mortgage amount")?.value).replace(/[^0-9.]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
