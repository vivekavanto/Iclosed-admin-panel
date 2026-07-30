"use client";

import { use } from "react";
import ClosingCostCalculator from "@/components/ClosingCostCalculator";

export default function DealClosingCostsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ClosingCostCalculator dealId={id} />;
}
