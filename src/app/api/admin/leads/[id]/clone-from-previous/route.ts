import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

/**
 * Clone-from-previous endpoint. Lets an admin prepopulate the current
 * lead's personal fields and identification documents from a prior lead
 * belonging to the same client (matched by email).
 *
 * GET  /api/admin/leads/[id]/clone-from-previous
 *   → lists candidate prior leads (same email, different id).
 * POST /api/admin/leads/[id]/clone-from-previous
 *   body: { sourceLeadId, copyFields?: boolean, copyDocs?: boolean }
 *   → applies the clone. Only fills empty fields; skips duplicate doc rows.
 */

const PERSONAL_FIELDS = [
  "first_name",
  "last_name",
  "phone",
  "address_street",
  "address_unit",
  "address_city",
  "address_province",
  "address_postal_code",
  "citizenship_status",
] as const;

type PersonalField = (typeof PERSONAL_FIELDS)[number];

const isEmpty = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: targetLeadId } = await params;

    const { data: target, error: targetErr } = await supabaseAdmin
      .from("leads")
      .select("id, email")
      .eq("id", targetLeadId)
      .maybeSingle();

    if (targetErr) {
      return NextResponse.json(
        { success: false, error: targetErr.message },
        { status: 500 },
      );
    }
    if (!target) {
      return NextResponse.json(
        { success: false, error: "Lead not found" },
        { status: 404 },
      );
    }
    if (!target.email) {
      return NextResponse.json({ success: true, candidates: [] });
    }

    const { data: siblings, error: siblingsErr } = await supabaseAdmin
      .from("leads")
      .select(
        "id, first_name, last_name, phone, address_street, address_unit, address_city, address_province, address_postal_code, citizenship_status, created_at",
      )
      .eq("email", target.email)
      .neq("id", targetLeadId)
      .order("created_at", { ascending: false });

    if (siblingsErr) {
      return NextResponse.json(
        { success: false, error: siblingsErr.message },
        { status: 500 },
      );
    }

    const siblingIds = (siblings ?? []).map((l) => l.id);
    if (siblingIds.length === 0) {
      return NextResponse.json({ success: true, candidates: [] });
    }

    const [{ data: deals }, { data: docs }] = await Promise.all([
      supabaseAdmin
        .from("deals")
        .select("id, lead_id, file_number, type, opening_date, created_at")
        .in("lead_id", siblingIds),
      supabaseAdmin
        .from("lead_corporate_docs")
        .select("lead_id, custom_type")
        .in("lead_id", siblingIds)
        .eq("doc_type", "identification"),
    ]);

    const firstDealByLead = new Map<string, any>();
    for (const d of deals ?? []) {
      if (!firstDealByLead.has(d.lead_id)) firstDealByLead.set(d.lead_id, d);
    }
    const docCountByLead = new Map<string, number>();
    for (const r of docs ?? []) {
      docCountByLead.set(r.lead_id, (docCountByLead.get(r.lead_id) ?? 0) + 1);
    }

    const candidates = (siblings ?? []).map((l) => {
      const d = firstDealByLead.get(l.id);
      return {
        lead_id: l.id,
        deal_file_number: d?.file_number ?? null,
        deal_type: d?.type ?? null,
        opening_date: d?.opening_date ?? null,
        created_at: l.created_at,
        doc_count: docCountByLead.get(l.id) ?? 0,
        snapshot: {
          first_name: l.first_name,
          last_name: l.last_name,
          phone: l.phone,
          address_street: l.address_street,
          address_unit: l.address_unit,
          address_city: l.address_city,
          address_province: l.address_province,
          address_postal_code: l.address_postal_code,
          citizenship_status: l.citizenship_status,
        },
      };
    });

    return NextResponse.json({ success: true, candidates });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: targetLeadId } = await params;
    const body = await req.json().catch(() => null);

    const sourceLeadId =
      typeof body?.sourceLeadId === "string" ? body.sourceLeadId : null;
    const copyFields = body?.copyFields !== false;
    const copyDocs = body?.copyDocs !== false;
    const copyResponses = body?.copyResponses !== false;

    if (!sourceLeadId) {
      return NextResponse.json(
        { success: false, error: "sourceLeadId is required" },
        { status: 400 },
      );
    }
    if (sourceLeadId === targetLeadId) {
      return NextResponse.json(
        { success: false, error: "sourceLeadId must differ from target" },
        { status: 400 },
      );
    }

    const { data: pair, error: pairErr } = await supabaseAdmin
      .from("leads")
      .select(
        "id, email, first_name, last_name, phone, address_street, address_unit, address_city, address_province, address_postal_code, citizenship_status",
      )
      .in("id", [sourceLeadId, targetLeadId]);

    if (pairErr) {
      return NextResponse.json(
        { success: false, error: pairErr.message },
        { status: 500 },
      );
    }
    const source = (pair ?? []).find((l) => l.id === sourceLeadId);
    const target = (pair ?? []).find((l) => l.id === targetLeadId);
    if (!source || !target) {
      return NextResponse.json(
        { success: false, error: "Source or target lead not found" },
        { status: 404 },
      );
    }
    if (
      !source.email ||
      !target.email ||
      source.email.toLowerCase() !== target.email.toLowerCase()
    ) {
      return NextResponse.json(
        { success: false, error: "Source and target leads must share an email" },
        { status: 403 },
      );
    }

    const copiedFields: PersonalField[] = [];
    if (copyFields) {
      const update: Partial<Record<PersonalField, unknown>> = {};
      for (const f of PERSONAL_FIELDS) {
        const srcVal = (source as any)[f];
        const tgtVal = (target as any)[f];
        if (!isEmpty(srcVal) && isEmpty(tgtVal)) {
          update[f] = srcVal;
          copiedFields.push(f);
        }
      }
      if (copiedFields.length > 0) {
        const { error: updErr } = await supabaseAdmin
          .from("leads")
          .update(update)
          .eq("id", targetLeadId);
        if (updErr) {
          return NextResponse.json(
            { success: false, error: updErr.message },
            { status: 500 },
          );
        }
      }
    }

    let copiedDocCount = 0;
    if (copyDocs) {
      const [{ data: srcDocs, error: srcDocsErr }, { data: tgtDocs, error: tgtDocsErr }] =
        await Promise.all([
          supabaseAdmin
            .from("lead_corporate_docs")
            .select("file_name, file_url, doc_type, custom_type")
            .eq("lead_id", sourceLeadId)
            .eq("doc_type", "identification"),
          supabaseAdmin
            .from("lead_corporate_docs")
            .select("custom_type")
            .eq("lead_id", targetLeadId)
            .eq("doc_type", "identification"),
        ]);
      if (srcDocsErr || tgtDocsErr) {
        return NextResponse.json(
          { success: false, error: (srcDocsErr ?? tgtDocsErr)?.message },
          { status: 500 },
        );
      }

      const occupied = new Set(
        (tgtDocs ?? [])
          .map((r) => (r.custom_type ?? "").toLowerCase())
          .filter(Boolean),
      );
      const toInsert = (srcDocs ?? [])
        .filter((d) => {
          const ct = (d.custom_type ?? "").toLowerCase();
          return ct ? !occupied.has(ct) : true;
        })
        .map((d) => ({
          lead_id: targetLeadId,
          file_name: d.file_name,
          file_url: d.file_url,
          doc_type: d.doc_type,
          custom_type: d.custom_type,
        }));

      if (toInsert.length > 0) {
        const { error: insErr } = await supabaseAdmin
          .from("lead_corporate_docs")
          .insert(toInsert);
        if (insErr) {
          return NextResponse.json(
            { success: false, error: insErr.message },
            { status: 500 },
          );
        }
        copiedDocCount = toInsert.length;
      }
    }

    let copiedResponseCount = 0;
    if (copyResponses) {
      // Resolve the deal_id on each side. A lead can theoretically have
      // multiple deals (shouldn't, but guard against it); pick the most
      // recent so the most up-to-date answers win on the source side, and
      // the most recent on the target so we don't accidentally write into
      // an archived deal.
      const { data: dealRows, error: dealErr } = await supabaseAdmin
        .from("deals")
        .select("id, lead_id, created_at")
        .in("lead_id", [sourceLeadId, targetLeadId])
        .order("created_at", { ascending: false });
      if (dealErr) {
        return NextResponse.json(
          { success: false, error: dealErr.message },
          { status: 500 },
        );
      }
      const sourceDealId = (dealRows ?? []).find(
        (d) => d.lead_id === sourceLeadId,
      )?.id;
      const targetDealId = (dealRows ?? []).find(
        (d) => d.lead_id === targetLeadId,
      )?.id;

      if (sourceDealId && targetDealId) {
        // Pull task rows for both deals. Match across deals by
        // task_template_id (same template = same kind of task, with the
        // same form fields). Tasks without a template are admin-created
        // and can't be matched, so we skip them.
        const [{ data: sourceTasks, error: srcTasksErr }, { data: targetTasks, error: tgtTasksErr }] =
          await Promise.all([
            supabaseAdmin
              .from("tasks")
              .select("id, task_template_id, title")
              .eq("deal_id", sourceDealId),
            supabaseAdmin
              .from("tasks")
              .select("id, task_template_id, title")
              .eq("deal_id", targetDealId),
          ]);
        if (srcTasksErr || tgtTasksErr) {
          return NextResponse.json(
            { success: false, error: (srcTasksErr ?? tgtTasksErr)?.message },
            { status: 500 },
          );
        }

        // Skip identification tasks — those are handled by lead_corporate_docs
        // and the existing APS/ID upload flows would double-write into
        // task_responses if we cloned them here.
        const isIdTask = (title: string | null) =>
          (title ?? "").toLowerCase().includes("identif");

        const targetTaskByTemplate = new Map<string, string>();
        for (const t of targetTasks ?? []) {
          if (t.task_template_id && !isIdTask(t.title)) {
            targetTaskByTemplate.set(t.task_template_id, t.id);
          }
        }

        // For each source task that maps to a target task by template,
        // record both the source task_id and the destination task_id.
        const sourceTaskToTarget = new Map<string, string>();
        const sourceTaskIds: string[] = [];
        for (const t of sourceTasks ?? []) {
          if (!t.task_template_id || isIdTask(t.title)) continue;
          const tgt = targetTaskByTemplate.get(t.task_template_id);
          if (tgt) {
            sourceTaskToTarget.set(t.id, tgt);
            sourceTaskIds.push(t.id);
          }
        }

        if (sourceTaskIds.length > 0) {
          const targetTaskIds = Array.from(new Set(sourceTaskToTarget.values()));

          const [{ data: srcResponses, error: srcRespErr }, { data: tgtResponses, error: tgtRespErr }] =
            await Promise.all([
              supabaseAdmin
                .from("task_responses")
                .select("task_id, field_id, field_label, field_type, value, file_url, file_name")
                .in("task_id", sourceTaskIds),
              supabaseAdmin
                .from("task_responses")
                .select("task_id, field_id, field_label")
                .in("task_id", targetTaskIds),
            ]);
          if (srcRespErr || tgtRespErr) {
            return NextResponse.json(
              { success: false, error: (srcRespErr ?? tgtRespErr)?.message },
              { status: 500 },
            );
          }

          // Dedup key: `${target_task_id}::${field_id ?? field_label}`.
          // field_id is the stable identifier across deals (template field),
          // but legacy rows may have null field_id — fall back to label.
          const occupied = new Set<string>();
          for (const r of tgtResponses ?? []) {
            const key = `${r.task_id}::${r.field_id ?? r.field_label ?? ""}`;
            occupied.add(key);
          }

          const toInsert: Array<Record<string, unknown>> = [];
          for (const r of srcResponses ?? []) {
            const tgtTaskId = sourceTaskToTarget.get(r.task_id);
            if (!tgtTaskId) continue;
            const key = `${tgtTaskId}::${r.field_id ?? r.field_label ?? ""}`;
            if (occupied.has(key)) continue;
            occupied.add(key);
            toInsert.push({
              task_id: tgtTaskId,
              field_id: r.field_id,
              field_label: r.field_label,
              field_type: r.field_type,
              value: r.value,
              file_url: r.file_url,
              file_name: r.file_name,
            });
          }

          if (toInsert.length > 0) {
            const { error: insRespErr } = await supabaseAdmin
              .from("task_responses")
              .insert(toInsert);
            if (insRespErr) {
              return NextResponse.json(
                { success: false, error: insRespErr.message },
                { status: 500 },
              );
            }
            copiedResponseCount = toInsert.length;
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      copied_fields: copiedFields,
      copied_doc_count: copiedDocCount,
      copied_response_count: copiedResponseCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
