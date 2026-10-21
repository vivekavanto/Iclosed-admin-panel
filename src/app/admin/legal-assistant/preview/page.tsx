import { notFound } from "next/navigation";
import Orchestrator from "@/components/orchestrator/Orchestrator";
import { demoMatters } from "@/lib/orchestrator/demo";

export default function PreviewPage() {
  if (process.env.NODE_ENV !== "development" || process.env.ORCHESTRATOR_PREVIEW !== "true") notFound();
  return <Orchestrator initialMatters={demoMatters} initialImportDate="2026-10-20" preview manage />;
}
