import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { mortgageFromAnswers, type MortgageTaskAnswer } from "./mortgageAnswer";
import { logger } from "./logger";

export async function loadTaskMortgage(dealId: string): Promise<number | null> {
  try {
    const familyDealIds = await getFamilyDealIds(dealId);
    const dealIds = [dealId, ...familyDealIds.filter((d) => d !== dealId)];
    const { data: tasks } = await supabaseAdmin
      .from("tasks")
      .select("id, deal_id")
      .in("deal_id", dealIds)
      .eq("is_deleted", false)
      .or("side.is.null,side.eq.purchase");
    if (!tasks?.length) return null;

    const { data: rows } = await supabaseAdmin
      .from("task_responses")
      .select("task_id, field_label, value")
      .in("task_id", tasks.map((t) => t.id));
    const dealOfTask = new Map(tasks.map((t) => [t.id as string, t.deal_id as string]));
    const answers = (rows ?? []) as (MortgageTaskAnswer & { task_id: string })[];

    for (const id of dealIds) {
      const amount = mortgageFromAnswers(answers.filter((a) => dealOfTask.get(a.task_id) === id));
      if (amount !== null) return amount;
    }
    return null;
  } catch (err) {
    logger.error("[ClosingEstimate GET] mortgage task lookup failed:", err);
    return null;
  }
}
