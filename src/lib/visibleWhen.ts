/**
 * Conditional visibility for DB-driven task form fields.
 *
 * A field's `options` JSON can carry a `visible_when` rule that hides it until
 * another field is answered a certain way. Shapes (set in the DB, never
 * hardcoded here):
 *
 *   { "visible_when": { "field_label": "<parent>", "equals": "<value>" } }
 *   { "visible_when": { "field_label": "<parent>", "equals_any": [...] } }
 *   { "visible_when": { "all": [ <clause>, <clause> ] } }   // every clause must match
 *   { "visible_when": { "any": [ <clause>, <clause> ] } }   // at least one must match
 *   clause may use "not_equals" / "not_equals_any" instead
 *
 * Copy of iclosed-customer-application/src/lib/visibleWhen.ts — keep in sync.
 */

export type VisibleWhenClause = { field_label: string; values: string[]; negate?: true };

type RawClause = {
  field_label?: string;
  equals?: string;
  equals_any?: unknown;
  not_equals?: string;
  not_equals_any?: unknown;
};

type RawVisibleWhen = RawClause & { all?: RawClause[]; any?: RawClause[] };

function toValues(list: unknown, single: unknown): string[] {
  if (Array.isArray(list)) return list.map((v) => String(v));
  return single != null ? [String(single)] : [];
}

function parseRule(
  opts: unknown,
): { mode: "all" | "any"; clauses: VisibleWhenClause[] } | null {
  if (
    !opts ||
    typeof opts !== "object" ||
    Array.isArray(opts) ||
    !("visible_when" in opts)
  ) {
    return null;
  }
  const vw = (opts as { visible_when?: RawVisibleWhen }).visible_when;
  if (!vw) return null;
  const mode = Array.isArray(vw.any) ? "any" : "all";
  const raw = Array.isArray(vw.any) ? vw.any : Array.isArray(vw.all) ? vw.all : [vw];
  const clauses: VisibleWhenClause[] = [];
  for (const c of raw) {
    if (!c?.field_label) continue;
    const values = toValues(c.equals_any, c.equals);
    if (values.length > 0) {
      clauses.push({ field_label: String(c.field_label), values });
      continue;
    }
    const excluded = toValues(c.not_equals_any, c.not_equals);
    if (excluded.length > 0) {
      clauses.push({ field_label: String(c.field_label), values: excluded, negate: true });
    }
  }
  return clauses.length > 0 ? { mode, clauses } : null;
}

// A select's options hold its choices, so its rule lives in the visible_when column.
export function ruleSource(field: { options?: unknown; visible_when?: unknown }): unknown {
  return field.visible_when ? { visible_when: field.visible_when } : field.options;
}

/** Returns one entry per clause, or null when the field carries no usable rule. */
export function getVisibleWhen(opts: unknown): VisibleWhenClause[] | null {
  return parseRule(opts)?.clauses ?? null;
}

/**
 * Whether a field's rule is currently satisfied: every clause for `all`, at least
 * one for `any`. Parents are matched by label and values
 * compared case-insensitively. Fails open: no rule, or a parent that isn't on
 * the form, leaves the field visible.
 */
export function isVisibleByRules(
  opts: unknown,
  fields: { id: string; label: string }[],
  values: Record<string, string>,
): boolean {
  const rule = parseRule(opts);
  if (!rule) return true;
  const matches = (clause: VisibleWhenClause) => {
    const parent = fields.find(
      (f) => f.label.trim().toLowerCase() === clause.field_label.trim().toLowerCase(),
    );
    if (!parent) return true;
    const current = (values[parent.id] ?? "").trim().toLowerCase();
    const hit = clause.values.some((v) => v.trim().toLowerCase() === current);
    return clause.negate ? !hit : hit;
  };
  return rule.mode === "any" ? rule.clauses.some(matches) : rule.clauses.every(matches);
}
