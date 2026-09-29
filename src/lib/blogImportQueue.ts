import { del } from "@vercel/blob";
import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { createPost, getPostById, listTitlesAndSlugs, slugify, updatePost } from "./blogPosts";
import { extractMultipleBlogArticles, MAX_BLOG_CHARS, MAX_IMPORT_BYTES } from "./blogImport";
import { formatBlogHtml } from "./blogFormat";
import { generateBlogSeo } from "./blogSeo";
import { generateBlogCoverImage } from "./blogCoverImage";
import { readBlobDocument } from "./blobDocument";
import { blobTokenForUrl } from "./blobPrivacy";
import { computeServiceSignature } from "./verifyServiceSignature";
import { revalidatePortalBlog } from "./revalidatePortalBlog";

/**
 * Background queue for multi-article blog imports.
 *
 * The admin uploads a document and gets control back immediately; everything
 * slow happens here, one job per claim, with its state in two tables (see
 * migrations/2026-09-29-blog-import-queue.sql):
 *
 *   blog_import_batches  one per upload. queued → extracting → processing →
 *                        completed | failed | cancelled
 *   blog_import_items    one per article, each tied to its own DRAFT
 *                        blog_posts row, created as soon as the document is
 *                        split. queued → processing → done | failed
 *
 * Who runs the jobs (no queue vendor, no cron needed):
 *   1. POST /api/admin/blog/batches kicks the worker right after enqueueing.
 *   2. The worker route (/api/internal/blog-import/run) processes jobs for up
 *      to RUN_BUDGET_MS, then kicks a FRESH invocation of itself to carry on —
 *      so no single function has to survive the whole batch.
 *   3. The Blogs page's progress poll also runs a job in-process whenever work
 *      is waiting — the safety net if a kick is lost or the signing secret is
 *      missing. claim_blog_import_job() caps concurrency globally, so extra
 *      runners just find nothing to claim.
 */

/** Same number BlogBatchManager used client-side: fast without a Gemini burst. */
export const MAX_IN_FLIGHT = 3;
const MAX_ATTEMPTS = 3;
/** Longer than the slowest item (~170s: format‖SEO alongside prompt+image). */
const LEASE_SECONDS = 330;
/** Stop claiming new jobs after this, leaving room for the last one to finish under maxDuration 300. */
const RUN_BUDGET_MS = 110_000;

const DEFAULT_AUTHOR = "iClosed Real Estate Law Desk";

type StepStatus = "pending" | "done" | "failed" | "skipped";

export type ImportBatchRow = {
  id: string;
  created_at: string;
  created_by_email: string | null;
  file_name: string;
  blob_url: string | null;
  status: "queued" | "extracting" | "processing" | "completed" | "failed" | "cancelled";
  publish_when_ready: boolean;
  total: number;
  published: number;
  error: string | null;
  attempts: number;
  finished_at: string | null;
};

export type ImportItemRow = {
  id: string;
  batch_id: string;
  post_id: string | null;
  idx: number;
  title: string;
  char_count: number;
  is_duplicate: boolean;
  needs_review: boolean;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  format_status: StepStatus;
  seo_status: StepStatus;
  image_status: StepStatus;
  warnings: string[];
  last_error: string | null;
  attempts: number;
};

const ACTIVE_BATCH_STATUSES = ["queued", "extracting", "processing"] as const;

// ── Enqueue ─────────────────────────────────────────────────────────────

export async function enqueueImportBatch(input: {
  blobUrl: string;
  fileName: string;
  publishWhenReady: boolean;
  adminEmail: string | null;
}): Promise<{ ok: true; batchId: string } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("blog_import_batches")
    .insert({
      file_name: input.fileName,
      blob_url: input.blobUrl,
      publish_when_ready: input.publishWhenReady,
      created_by_email: input.adminEmail,
    })
    .select("id")
    .single();

  if (error || !data) {
    logger.error("[blogImportQueue] enqueue failed:", error?.message);
    return { ok: false, error: "Could not queue the import. Try again." };
  }
  return { ok: true, batchId: (data as { id: string }).id };
}

// ── Kicking the worker ──────────────────────────────────────────────────

/**
 * Starts `times` fresh worker invocations. Signed with SERVICE_WEBHOOK_SECRET
 * because the worker route sits outside /api/admin (the self-call carries no
 * admin cookie). Resolves once each request is accepted — the worker answers
 * 202 and does the work in after(), so this never waits on Gemini.
 */
export async function kickImportWorker(origin: string, times = 1): Promise<void> {
  const body = "{}";
  await Promise.all(
    Array.from({ length: Math.max(0, times) }, async () => {
      const timestamp = String(Date.now());
      try {
        const res = await fetch(`${origin}/api/internal/blog-import/run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-iclosed-timestamp": timestamp,
            "x-iclosed-signature": computeServiceSignature(timestamp, body),
          },
          body,
          cache: "no-store",
        });
        if (!res.ok) logger.warn(`[blogImportQueue] worker kick answered ${res.status}`);
      } catch (err) {
        logger.warn(
          `[blogImportQueue] worker kick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
}

// ── Running jobs ────────────────────────────────────────────────────────

async function claimJob(): Promise<{ kind: "extract" | "item"; id: string } | null> {
  const { data, error } = await supabaseAdmin.rpc("claim_blog_import_job", {
    p_max_in_flight: MAX_IN_FLIGHT,
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) {
    logger.error("[blogImportQueue] claim failed:", error.message);
    return null;
  }
  const row = (data as { job_kind: string; job_id: string }[] | null)?.[0];
  if (!row) return null;
  return { kind: row.job_kind as "extract" | "item", id: row.job_id };
}

/** Runs one job if one can be claimed. Returns what it ran. */
export async function runOneJob(origin: string): Promise<"extract" | "item" | null> {
  const job = await claimJob();
  if (!job) return null;
  try {
    if (job.kind === "extract") {
      const created = await processExtractJob(job.id);
      // Fan out: this invocation keeps one lane, the kicks open the others.
      if (created > 1) await kickImportWorker(origin, Math.min(created, MAX_IN_FLIGHT) - 1);
    } else {
      await processItemJob(job.id);
    }
  } catch (err) {
    // A throw here is a bug or an infra blip, not a Gemini failure (those are
    // handled per step). Leave the lease to expire and the claim RPC retries it.
    logger.error(
      `[blogImportQueue] ${job.kind} job ${job.id} threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return job.kind;
}

/**
 * The worker loop: claim and run jobs until the queue is empty or the time
 * budget is spent, then hand over to a fresh invocation if work remains.
 * Waits out a short retry backoff rather than exiting, so a transient Gemini
 * failure doesn't strand a batch with nobody left to pick it up.
 */
export async function runImportWorker(origin: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < RUN_BUDGET_MS) {
    const ran = await runOneJob(origin);
    if (ran) continue;

    const waitMs = await msUntilNextDelayedJob();
    if (waitMs === null) return; // nothing queued at all — done
    if (waitMs < 0) return; // queued and due, but the concurrency cap is full: the others will get it
    if (Date.now() - started + waitMs >= RUN_BUDGET_MS) break;
    await new Promise((r) => setTimeout(r, waitMs + 250));
  }
  // Budget spent with work possibly left — continue in a new invocation.
  if (await hasQueuedWork()) await kickImportWorker(origin, 1);
}

async function msUntilNextDelayedJob(): Promise<number | null> {
  const [items, batches] = await Promise.all([
    supabaseAdmin
      .from("blog_import_items")
      .select("run_after")
      .eq("status", "queued")
      .order("run_after", { ascending: true })
      .limit(1),
    supabaseAdmin
      .from("blog_import_batches")
      .select("run_after")
      .eq("status", "queued")
      .order("run_after", { ascending: true })
      .limit(1),
  ]);
  const times = [...(items.data ?? []), ...(batches.data ?? [])].map((r) =>
    new Date((r as { run_after: string }).run_after).getTime(),
  );
  if (times.length === 0) return null;
  return Math.min(...times) - Date.now();
}

async function hasQueuedWork(): Promise<boolean> {
  return (await msUntilNextDelayedJob()) !== null;
}

// ── Extract job ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Readable placeholder body for a draft before (or if never) Gemini formats
 * it — paragraphs split on blank lines — so a draft that the admin opens early,
 * or whose formatting fails for good, still shows the author's words.
 */
function plainTextToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function fallbackExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function deleteScratchBlob(url: string | null): Promise<void> {
  if (!url) return;
  try {
    await del(url, { token: blobTokenForUrl(url) });
  } catch (err) {
    logger.warn(
      `[blogImportQueue] could not delete import blob: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function getBatch(id: string): Promise<ImportBatchRow | null> {
  const { data } = await supabaseAdmin.from("blog_import_batches").select("*").eq("id", id).maybeSingle();
  return (data as ImportBatchRow | null) ?? null;
}

async function failBatch(batch: ImportBatchRow, error: string): Promise<void> {
  await supabaseAdmin
    .from("blog_import_batches")
    .update({ status: "failed", error, finished_at: new Date().toISOString(), locked_until: null, updated_at: new Date().toISOString() })
    .eq("id", batch.id);
  await deleteScratchBlob(batch.blob_url);
  logger.warn(`[blogImportQueue] batch ${batch.id} failed: ${error}`);
}

/** Splits the document and creates one draft + one item per article. Returns the item count. */
async function processExtractJob(batchId: string): Promise<number> {
  const batch = await getBatch(batchId);
  if (!batch || batch.status !== "extracting") return 0;

  if (!batch.blob_url) {
    await failBatch(batch, "The uploaded document is no longer available. Upload it again.");
    return 0;
  }

  let file: File;
  try {
    const { bytes, meta } = await readBlobDocument(batch.blob_url, MAX_IMPORT_BYTES);
    file = new File([new Uint8Array(bytes)], batch.file_name, { type: meta.contentType });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read the uploaded file.";
    if (batch.attempts >= MAX_ATTEMPTS) {
      await failBatch(batch, message);
    } else {
      await requeueBatch(batch.id, message, batch.attempts);
    }
    return 0;
  }

  const extracted = await extractMultipleBlogArticles(file);
  if (!extracted.ok) {
    // A document we can't split is a property of the file, not a blip — retrying won't help.
    await failBatch(batch, extracted.error);
    return 0;
  }

  const articles = extracted.data;
  const existingSlugs = new Set((await listTitlesAndSlugs()).map((p) => p.slug.toLowerCase()));
  const seenInBatch = new Set<string>();
  const author = batch.created_by_email ?? "import-batch";

  const itemRows: Record<string, unknown>[] = [];
  for (let idx = 0; idx < articles.length; idx++) {
    const a = articles[idx];
    const title = a.title?.trim() || "Untitled";

    // Checked BEFORE this batch's own drafts exist, or every article would match itself.
    const slug = slugify(title);
    const isDuplicate = existingSlugs.has(slug) || seenInBatch.has(slug);
    seenInBatch.add(slug);
    const charCount = a.text.length;

    const created = await createPost(
      {
        title,
        status: "draft",
        content_html: a.preformattedHtml ?? plainTextToHtml(a.text),
        content_source: a.text,
        excerpt: fallbackExcerpt(a.text),
        cover_image_url: null,
        cover_image_alt: null,
        author: DEFAULT_AUTHOR,
        tags: [],
        faq: [],
        noindex: false,
        format_source: "manual",
        seo_source: "manual",
        import_batch_id: batch.id,
      },
      author,
    );

    const warnings = [...a.warnings];
    if (a.needsProofread) warnings.push("Transcribed from a PDF — proofread before publishing.");

    itemRows.push({
      batch_id: batch.id,
      post_id: created.ok ? created.row.id : null,
      idx,
      title,
      char_count: charCount,
      is_duplicate: isDuplicate,
      needs_review: isDuplicate || charCount > MAX_BLOG_CHARS,
      status: created.ok ? "queued" : "failed",
      last_error: created.ok ? null : `Could not save the draft: ${created.error}`,
      format_status: a.preformattedHtml ? "skipped" : "pending",
      image_status: title !== "Untitled" && a.text.trim().length >= 200 ? "pending" : "skipped",
      warnings,
      finished_at: created.ok ? null : new Date().toISOString(),
    });
  }

  const { error: itemsError } = await supabaseAdmin.from("blog_import_items").insert(itemRows);
  if (itemsError) {
    logger.error("[blogImportQueue] inserting items failed:", itemsError.message);
    await failBatch(batch, "The drafts were created, but their processing could not be queued.");
    return 0;
  }

  await supabaseAdmin
    .from("blog_import_batches")
    .update({ status: "processing", total: articles.length, locked_until: null, updated_at: new Date().toISOString() })
    .eq("id", batch.id);

  await deleteScratchBlob(batch.blob_url);
  await supabaseAdmin.from("blog_import_batches").update({ blob_url: null }).eq("id", batch.id);

  logger.info(`[blogImportQueue] batch ${batch.id} — ${articles.length} articles from ${batch.file_name}`);

  // Every draft failed to save → nothing queued; close the batch now.
  await finishBatchIfDone(batch.id);
  return itemRows.filter((r) => r.status === "queued").length;
}

async function requeueBatch(id: string, error: string, attempts: number): Promise<void> {
  await supabaseAdmin
    .from("blog_import_batches")
    .update({
      status: "queued",
      error,
      locked_until: null,
      run_after: new Date(Date.now() + 15_000 * attempts).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

// ── Item job ────────────────────────────────────────────────────────────

async function getItem(id: string): Promise<ImportItemRow | null> {
  const { data } = await supabaseAdmin.from("blog_import_items").select("*").eq("id", id).maybeSingle();
  return (data as ImportItemRow | null) ?? null;
}

async function patchItem(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin
    .from("blog_import_items")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) logger.error(`[blogImportQueue] patchItem(${id}) failed:`, error.message);
}

const wants = (s: StepStatus) => s === "pending" || s === "failed";

/**
 * Format + SEO + cover image for one article, each written into the draft the
 * moment it succeeds. Only steps still pending/failed run, so a retry redoes
 * just what broke. Format‖SEO and the image run side by side — the image is
 * built from the raw text, not the formatted HTML.
 */
async function processItemJob(itemId: string): Promise<void> {
  const item = await getItem(itemId);
  if (!item || item.status !== "processing") return;

  const batch = await getBatch(item.batch_id);
  if (!batch || batch.status === "cancelled") {
    await patchItem(item.id, { status: "cancelled", locked_until: null, finished_at: new Date().toISOString() });
    return;
  }

  const post = item.post_id ? await getPostById(item.post_id) : null;
  if (!post) {
    await patchItem(item.id, {
      status: "failed",
      last_error: "The draft was deleted before it could be processed.",
      locked_until: null,
      finished_at: new Date().toISOString(),
    });
    await finishBatchIfDone(item.batch_id);
    return;
  }

  const editor = batch.created_by_email ?? "import-batch";
  const text = post.content_source ?? "";
  const title = post.title;
  const notes: string[] = [];
  const errors: string[] = [];

  let formatStatus = item.format_status;
  let seoStatus = item.seo_status;
  let imageStatus = item.image_status;

  const formatTask = wants(formatStatus)
    ? formatBlogHtml({ body: text, title }).then(async (r) => {
        if (!r.ok) {
          formatStatus = "failed";
          errors.push(`Formatting: ${r.error}`);
          return;
        }
        const saved = await updatePost(
          post.id,
          {
            content_html: r.data.html,
            format_source: "gemini",
            format_model: r.data.model,
            formatted_at: new Date().toISOString(),
          },
          editor,
        );
        formatStatus = saved.ok ? "done" : "failed";
        if (saved.ok) notes.push(...r.data.warnings);
        else errors.push(`Formatting: ${saved.error}`);
      })
    : Promise.resolve();

  const seoTask = wants(seoStatus)
    ? generateBlogSeo({ title, body: text }).then(async (r) => {
        if (!r.ok) {
          seoStatus = "failed";
          errors.push(`SEO: ${r.error}`);
          return;
        }
        const saved = await updatePost(
          post.id,
          {
            meta_title: r.data.metaTitle || null,
            meta_description: r.data.metaDescription || null,
            focus_keyword: r.data.focusKeyword || null,
            excerpt: r.data.excerpt?.trim() || post.excerpt || fallbackExcerpt(text),
            tags: r.data.tags ?? [],
            faq: r.data.faq ?? [],
            seo_source: "gemini",
          },
          editor,
        );
        seoStatus = saved.ok ? "done" : "failed";
        if (saved.ok) notes.push(...r.data.warnings);
        else errors.push(`SEO: ${saved.error}`);
      })
    : Promise.resolve();

  const imageTask = wants(imageStatus)
    ? generateBlogCoverImage({ title, body: text }).then(async (r) => {
        if (!r.ok) {
          imageStatus = "failed";
          errors.push(`Cover image: ${r.error}`);
          return;
        }
        const saved = await updatePost(post.id, { cover_image_url: r.url, cover_image_alt: r.alt }, editor);
        imageStatus = saved.ok ? "done" : "failed";
        if (!saved.ok) errors.push(`Cover image: ${saved.error}`);
      })
    : Promise.resolve();

  // Each task catches its own Gemini failure; allSettled covers a thrown DB error.
  const settled = await Promise.allSettled([formatTask, seoTask, imageTask]);
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      if (i === 0) formatStatus = "failed";
      if (i === 1) seoStatus = "failed";
      if (i === 2) imageStatus = "failed";
      errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
    }
  });

  const anyFailed = [formatStatus, seoStatus, imageStatus].includes("failed");
  const canRetry = anyFailed && item.attempts < MAX_ATTEMPTS;
  // The cover image is optional: once retries are spent, missing only the
  // image still counts as a finished article (with a warning).
  const textStepsOk = formatStatus !== "failed" && seoStatus !== "failed";

  const warnings = [...item.warnings, ...notes];
  if (!canRetry && imageStatus === "failed") {
    warnings.push("A cover image could not be generated — add one in the editor.");
  }

  await patchItem(item.id, {
    format_status: formatStatus,
    seo_status: seoStatus,
    image_status: imageStatus,
    warnings,
    last_error: errors.length ? errors.join(" · ") : null,
    locked_until: null,
    ...(canRetry
      ? { status: "queued", run_after: new Date(Date.now() + 20_000 * item.attempts).toISOString() }
      : { status: textStepsOk ? "done" : "failed", finished_at: new Date().toISOString() }),
  });

  if (!canRetry) await finishBatchIfDone(item.batch_id);
}

// ── Finishing a batch ───────────────────────────────────────────────────

/** Mirrors the pre-flight checks of POST /api/admin/blog/[id]/publish. */
async function publishDraft(postId: string, editor: string): Promise<boolean> {
  const post = await getPostById(postId);
  if (!post || post.status === "published") return false;
  if (!post.content_html?.trim() || !post.excerpt?.trim()) return false;
  const result = await updatePost(
    postId,
    { status: "published", published_at: post.published_at ?? new Date().toISOString() },
    editor,
  );
  if (!result.ok) return false;
  await revalidatePortalBlog({ slug: result.row.slug });
  return true;
}

/**
 * Closes the batch once no item is queued or running. Only the caller that
 * wins finish_blog_import_batch() continues, so the auto-publish happens
 * exactly once.
 */
export async function finishBatchIfDone(batchId: string): Promise<void> {
  const { data: won, error } = await supabaseAdmin.rpc("finish_blog_import_batch", { p_batch_id: batchId });
  if (error) {
    logger.error("[blogImportQueue] finish_blog_import_batch failed:", error.message);
    return;
  }
  if (won !== true) return;

  const batch = await getBatch(batchId);
  if (!batch) return;

  const { data } = await supabaseAdmin
    .from("blog_import_items")
    .select("post_id, status, needs_review")
    .eq("batch_id", batchId);
  const items = (data ?? []) as Pick<ImportItemRow, "post_id" | "status" | "needs_review">[];
  const done = items.filter((i) => i.status === "done");
  const failed = items.filter((i) => i.status === "failed").length;

  let published = 0;
  if (batch.publish_when_ready) {
    const editor = batch.created_by_email ?? "import-batch";
    for (const item of done) {
      // Oversized or possible duplicates stay drafts until a human clears them.
      if (item.needs_review || !item.post_id) continue;
      if (await publishDraft(item.post_id, editor)) published += 1;
    }
    await supabaseAdmin.from("blog_import_batches").update({ published }).eq("id", batchId);
  }

  logger.info(
    `[blogImportQueue] batch ${batchId} completed — ${done.length}/${items.length} done, ${failed} failed, ${published} published`,
  );
}

// ── Reads + admin actions for the progress UI ───────────────────────────

export type BatchWithItems = ImportBatchRow & { items: ImportItemRow[] };

/**
 * What the progress panel shows: every running batch. A completed or
 * cancelled import disappears on its own — its drafts are in the posts list.
 * An import that failed outright (the document could not be read) stays until
 * dismissed, because there are no drafts to show for it and the admin needs
 * to see why.
 */
export async function listVisibleBatches(): Promise<BatchWithItems[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("blog_import_batches")
    .select("*")
    .is("dismissed_at", null)
    .or(`status.in.(${ACTIVE_BATCH_STATUSES.join(",")}),and(status.eq.failed,finished_at.gte.${since})`)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    logger.error("[blogImportQueue] listVisibleBatches failed:", error.message);
    return [];
  }
  const batches = (data ?? []) as ImportBatchRow[];
  if (batches.length === 0) return [];

  const { data: itemData } = await supabaseAdmin
    .from("blog_import_items")
    .select("*")
    .in(
      "batch_id",
      batches.map((b) => b.id),
    )
    .order("idx", { ascending: true });
  const items = (itemData ?? []) as ImportItemRow[];

  return batches.map((b) => ({ ...b, items: items.filter((i) => i.batch_id === b.id) }));
}

export function isBatchActive(b: Pick<ImportBatchRow, "status">): boolean {
  return (ACTIVE_BATCH_STATUSES as readonly string[]).includes(b.status);
}

export async function cancelBatch(batchId: string): Promise<boolean> {
  const batch = await getBatch(batchId);
  if (!batch || !isBatchActive(batch)) return false;
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("blog_import_batches")
    .update({ status: "cancelled", finished_at: now, updated_at: now })
    .eq("id", batchId);
  // Running items finish writing into their drafts; queued ones never start.
  await supabaseAdmin
    .from("blog_import_items")
    .update({ status: "cancelled", finished_at: now, updated_at: now })
    .eq("batch_id", batchId)
    .eq("status", "queued");
  if (batch.status === "queued") await deleteScratchBlob(batch.blob_url);
  return true;
}

export async function dismissBatch(batchId: string): Promise<void> {
  await supabaseAdmin
    .from("blog_import_batches")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", batchId);
}
