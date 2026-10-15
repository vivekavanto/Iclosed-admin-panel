// When a set of uploaded identification documents is good enough to submit.
//
// The firm's rule has two halves, and BOTH are hard blocks — neither is a
// "you can still submit" nudge:
//
//   1. BOTH SIDES of every ID. Identity can't be verified from one side of a
//      document. For a passport the second side is the SIGNATURE page, not the
//      blank rear cover.
//   2. TWO DIFFERENT TYPES of ID. A driver's licence photographed front and back
//      is ONE piece of identification, not two — that used to satisfy an "at
//      least 2 files" check and let a client submit a single ID.
//
// Pure and dependency-free so tests/idDocumentRules.test.ts can drive it;
// src/components/UploadIdentificationDrawer.tsx renders the copy around it.

/** Which side(s) of a document one uploaded file shows. */
export type IdSide = "front" | "back" | "front-and-back" | "unknown";

/**
 * ID types that are a single physical page with no second side worth asking
 * for — a birth certificate's reverse is typically blank. Any one established
 * side (front, back, or a scan that happens to show both) completes these.
 */
const SINGLE_SIDED_TYPES = new Set(["birth certificate"]);

function isSingleSided(type: string): boolean {
  return SINGLE_SIDED_TYPES.has(type.trim().toLowerCase());
}

/** One detected document, from a freshly analysed file or a saved draft row. */
export interface DetectedIdDoc {
  /** The acceptable-ID label, e.g. "Driver's License" or "Canadian Passport". */
  type: string;
  side: IdSide | string;
}

/** Side coverage for one document TYPE, across every file that shows it. */
export interface IdTypeAnalysis {
  type: string;
  hasFront: boolean;
  hasBack: boolean;
  /** One image showing both sides — an open passport spread, a two-up scan. */
  hasBothSides: boolean;
  complete: boolean;
}

export type IdBlockerKind = "incomplete-sides" | "needs-second-type";

export interface IdSubmissionBlocker {
  kind: IdBlockerKind;
  /** Types still missing a side, for "incomplete-sides". */
  incomplete: IdTypeAnalysis[];
}

/**
 * Human name for a document's SECOND side.
 *
 * On a passport that page is the signature page — the page the firm actually
 * needs; calling it "the back" points people at the blank rear cover. Card-style
 * IDs really do have a back.
 */
export function secondSideLabel(type: string): string {
  return /passport/i.test(type) ? "signature page" : "back";
}

/** The page(s) still owed for one document: "back", "signature page", "front". */
export function describeMissingSides(doc: Pick<IdTypeAnalysis, "type" | "hasFront" | "hasBack">): string {
  const second = secondSideLabel(doc.type);
  if (!doc.hasFront && !doc.hasBack) return `front & ${second}`;
  return doc.hasFront ? second : "front";
}

/**
 * Group detected documents by TYPE and work out each one's side coverage.
 *
 * Grouping by type is what makes "two IDs" mean two different documents: every
 * file showing a driver's licence lands in the same group however many files
 * there are, so the licence can only ever count once.
 *
 * Order follows first appearance, so the UI lists documents in upload order.
 */
export function analyseIdSides(docs: DetectedIdDoc[]): IdTypeAnalysis[] {
  const groups = new Map<string, DetectedIdDoc[]>();
  for (const doc of docs) {
    const key = doc.type;
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }

  return [...groups.entries()].map(([type, group]) => {
    const hasFront = group.some((d) => d.side === "front");
    const hasBack = group.some((d) => d.side === "back");
    const hasBothSides = group.some((d) => d.side === "front-and-back");
    return {
      type,
      hasFront,
      hasBack,
      hasBothSides,
      // A single image holding both sides is complete on its own; otherwise the
      // front and the second side must each have turned up somewhere. Single-
      // sided types (e.g. Birth Certificate) are complete with any one side.
      complete: isSingleSided(type)
        ? hasFront || hasBack || hasBothSides
        : hasBothSides || (hasFront && hasBack),
    };
  });
}

/** Distinct document types that are complete on both sides. */
export function completeIdTypes(analysis: IdTypeAnalysis[]): IdTypeAnalysis[] {
  return analysis.filter((d) => d.complete);
}

/**
 * What stops this set from being submitted, or null when nothing does.
 *
 * A missing side is reported ahead of a missing second ID: it names a specific
 * page the client can go and photograph, which is the more actionable of the
 * two. Copy lives in the component — this returns the verdict, not the wording.
 */
export function idSubmissionBlocker(analysis: IdTypeAnalysis[]): IdSubmissionBlocker | null {
  const incomplete = analysis.filter((d) => !d.complete);
  if (incomplete.length > 0) return { kind: "incomplete-sides", incomplete };
  if (completeIdTypes(analysis).length < 2) return { kind: "needs-second-type", incomplete: [] };
  return null;
}
