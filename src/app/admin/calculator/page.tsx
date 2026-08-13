"use client";

import QuickClosingCostCalculator from "@/components/QuickClosingCostCalculator";

// /admin/calculator — the standalone closing-cost calculator, reachable from the
// sidebar so every clerk has it without opening a file first.
export default function CalculatorPage() {
  return <QuickClosingCostCalculator />;
}
