import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { recalcMilestonesForFamily } from "@/lib/recalcMilestones";

type Milestone = {
  id: string;
  deal_id: string;
  title: string | null;
  status: string | null;
  completed_at: string | null;
  order_index: number | null;
  email_sent: boolean | null;
  created_at?: string | null;
};

type Task = {
  id: string;
  deal_id: string;
  title: string | null;
  status: string | null;
  milestone_id: string | null;
  completed_at: string | null;
  created_at?: string | null;
};

function isCombinedType(type: string | null | undefined): boolean {
  if (!type) return false;
  const t = type.toLowerCase();
  return t.includes("purchase") && t.includes("sale");
}

function lowerKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

const COMPLETED = "Completed";

export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const targetDealId: string | undefined = body?.deal_id;
  const dryRun: boolean = body?.dry_run === true;

  // ── Find combined deals ─────────────────────────────────────────────────
  const dealsQuery = supabaseAdmin.from("deals").select("id, type");
  const { data: allDeals, error: dealsErr } = targetDealId
    ? await dealsQuery.eq("id", targetDealId)
    : await dealsQuery;

  if (dealsErr) {
    return NextResponse.json({ success: false, error: dealsErr.message }, { status: 500 });
  }

  const combinedDeals = (allDeals ?? []).filter((d: any) => isCombinedType(d.type));

  const summary: {
    deals_processed: number;
    milestones_removed: number;
    tasks_removed: number;
    task_responses_relinked: number;
    tasks_relinked_to_kept_milestone: number;
    per_deal: Array<{
      deal_id: string;
      milestones_removed: number;
      tasks_removed: number;
      task_responses_relinked: number;
      tasks_relinked: number;
      error?: string;
    }>;
  } = {
    deals_processed: 0,
    milestones_removed: 0,
    tasks_removed: 0,
    task_responses_relinked: 0,
    tasks_relinked_to_kept_milestone: 0,
    per_deal: [],
  };

  const processedFamilies = new Set<string>();

  for (const deal of combinedDeals) {
    const dealId = deal.id;
    const perDeal = {
      deal_id: dealId,
      milestones_removed: 0,
      tasks_removed: 0,
      task_responses_relinked: 0,
      tasks_relinked: 0,
      error: undefined as string | undefined,
    };

    try {
      // ── Dedupe milestones ─────────────────────────────────────────────
      const { data: msRows } = await supabaseAdmin
        .from("milestones")
        .select("id, deal_id, title, status, completed_at, order_index, email_sent, created_at")
        .eq("deal_id", dealId)
        .order("order_index", { ascending: true })
        .order("created_at", { ascending: true });

      const milestones: Milestone[] = (msRows ?? []) as any;
      const msGroups = new Map<string, Milestone[]>();
      for (const m of milestones) {
        const key = lowerKey(m.title);
        if (!key) continue;
        const arr = msGroups.get(key) ?? [];
        arr.push(m);
        msGroups.set(key, arr);
      }

      const msIdRedirect = new Map<string, string>(); // duplicate id → kept id
      const msIdsToDelete: string[] = [];
      const msPatches: { id: string; patch: Record<string, any> }[] = [];

      for (const [, group] of msGroups) {
        if (group.length <= 1) continue;
        const kept = group[0];
        const dups = group.slice(1);

        // If any duplicate is already Completed, propagate that to the kept one.
        const completedDup = dups.find((d) => d.status === COMPLETED) ?? (kept.status === COMPLETED ? kept : null);
        if (completedDup && kept.status !== COMPLETED) {
          msPatches.push({
            id: kept.id,
            patch: {
              status: COMPLETED,
              completed_at: completedDup.completed_at ?? new Date().toISOString(),
              email_sent: kept.email_sent || dups.some((d) => d.email_sent),
            },
          });
        }

        for (const d of dups) {
          msIdRedirect.set(d.id, kept.id);
          msIdsToDelete.push(d.id);
        }
      }

      if (msIdsToDelete.length > 0 && !dryRun) {
        // Apply status patches first
        for (const p of msPatches) {
          await supabaseAdmin.from("milestones").update(p.patch).eq("id", p.id);
        }

        // Re-link tasks pointing at duplicate milestones to the kept one
        for (const [dupId, keptId] of msIdRedirect.entries()) {
          const { count } = await supabaseAdmin
            .from("tasks")
            .update({ milestone_id: keptId }, { count: "exact" })
            .eq("milestone_id", dupId);
          perDeal.tasks_relinked += count ?? 0;
        }

        // Delete the duplicate milestones
        await supabaseAdmin.from("milestones").delete().in("id", msIdsToDelete);
        perDeal.milestones_removed = msIdsToDelete.length;
      } else if (dryRun) {
        perDeal.milestones_removed = msIdsToDelete.length;
      }

      // ── Dedupe tasks ──────────────────────────────────────────────────
      const { data: taskRows } = await supabaseAdmin
        .from("tasks")
        .select("id, deal_id, title, status, milestone_id, completed_at, created_at")
        .eq("deal_id", dealId)
        .order("created_at", { ascending: true });

      const tasks: Task[] = (taskRows ?? []) as any;
      const tGroups = new Map<string, Task[]>();
      for (const t of tasks) {
        const key = lowerKey(t.title);
        if (!key) continue;
        const arr = tGroups.get(key) ?? [];
        arr.push(t);
        tGroups.set(key, arr);
      }

      const taskIdsToDelete: string[] = [];
      const taskRedirects: { dupId: string; keptId: string }[] = [];
      const taskPatches: { id: string; patch: Record<string, any> }[] = [];

      for (const [, group] of tGroups) {
        if (group.length <= 1) continue;
        const kept = group[0];
        const dups = group.slice(1);

        const completedDup = dups.find((d) => d.status === COMPLETED) ?? (kept.status === COMPLETED ? kept : null);
        if (completedDup && kept.status !== COMPLETED) {
          taskPatches.push({
            id: kept.id,
            patch: {
              status: COMPLETED,
              completed_at: completedDup.completed_at ?? new Date().toISOString(),
            },
          });
        }

        for (const d of dups) {
          taskRedirects.push({ dupId: d.id, keptId: kept.id });
          taskIdsToDelete.push(d.id);
        }
      }

      if (taskIdsToDelete.length > 0 && !dryRun) {
        for (const p of taskPatches) {
          await supabaseAdmin.from("tasks").update(p.patch).eq("id", p.id);
        }

        for (const { dupId, keptId } of taskRedirects) {
          const { count } = await supabaseAdmin
            .from("task_responses")
            .update({ task_id: keptId }, { count: "exact" })
            .eq("task_id", dupId);
          perDeal.task_responses_relinked += count ?? 0;
        }

        await supabaseAdmin.from("tasks").delete().in("id", taskIdsToDelete);
        perDeal.tasks_removed = taskIdsToDelete.length;
      } else if (dryRun) {
        perDeal.tasks_removed = taskIdsToDelete.length;
      }

      // ── Recalc milestone statuses based on linked tasks ───────────────
      if (!dryRun && (perDeal.milestones_removed > 0 || perDeal.tasks_removed > 0 || perDeal.tasks_relinked > 0)) {
        try {
          const familyDealIds = await getFamilyDealIds(dealId);
          // Recalc once per family
          const familyKey = familyDealIds.slice().sort().join(",");
          if (!processedFamilies.has(familyKey)) {
            await recalcMilestonesForFamily(familyDealIds, dealId);
            processedFamilies.add(familyKey);
          }
        } catch (err) {
          console.error("[cleanup] recalc failed (non-blocking):", err);
        }
      }
    } catch (err: any) {
      perDeal.error = err?.message ?? String(err);
    }

    summary.per_deal.push(perDeal);
    summary.deals_processed += 1;
    summary.milestones_removed += perDeal.milestones_removed;
    summary.tasks_removed += perDeal.tasks_removed;
    summary.task_responses_relinked += perDeal.task_responses_relinked;
    summary.tasks_relinked_to_kept_milestone += perDeal.tasks_relinked;
  }

  return NextResponse.json({
    success: true,
    dry_run: dryRun,
    ...summary,
  });
}
