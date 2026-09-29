// E2E: duplicates are held (no draft), Remove saves nothing, Import anyway
// creates + processes a draft, and the batch only completes once every
// duplicate is decided. Cleans up everything it creates.
import fs from "fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const _warn = console.warn;
console.warn = (...a: unknown[]) => {
  if (!String(a[0]).includes("worker kick")) _warn(...a);
};

const { put, del } = await import("@vercel/blob");
const { blobToken, BLOB_ACCESS } = await import("./src/lib/blobPrivacy");
const q = await import("./src/lib/blogImportQueue");
const { getPostById, deletePost } = await import("./src/lib/blogPosts");
const supabaseAdmin = (await import("./src/lib/supabaseAdmin")).default;

const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

// An existing LIVE blog to collide with.
const { data: live } = await supabaseAdmin
  .from("blog_posts")
  .select("id, title")
  .eq("status", "published")
  .limit(1)
  .single();
if (!live) throw new Error("need one published post to collide with");
log(`colliding with existing blog: "${live.title}"`);

const para = (topic: string) =>
  `Buying a home in Ontario involves several legal steps around ${topic}. Your real estate lawyer reviews ` +
  `the agreement of purchase and sale, searches title, arranges title insurance and registers the transfer ` +
  `on closing day. Understanding ${topic} early helps you budget accurately and avoid surprises.`;
const article = (title: string, topic: string) => `# ${title}\n\n${para(topic)}\n\n${para(topic + " timelines")}`;

const NEW_TITLE = "E2E Dup Test: A Brand New Guide To Survey Certificates";
const doc = [
  article(live.title, "the existing topic"), // duplicate of a live blog
  article(NEW_TITLE, "survey certificates"), // new
  article(NEW_TITLE, "survey certificates again"), // repeated inside the same document
].join("\n\n---\n\n");

const blob = await put(`blog-imports/e2e-dup-${Date.now()}.md`, doc, {
  access: BLOB_ACCESS,
  token: blobToken(),
  contentType: "text/markdown",
  addRandomSuffix: true,
});
const queued = await q.enqueueImportBatch({
  blobUrl: blob.url,
  fileName: "e2e-dup-test.md",
  publishWhenReady: false,
  adminEmail: "e2e-test@iclosed.local",
});
if (!queued.ok) throw new Error(queued.error);
const batchId = queued.batchId;
const origin = "http://127.0.0.1:1";

const readItems = async () =>
  ((await supabaseAdmin.from("blog_import_items").select("*").eq("batch_id", batchId).order("idx")).data ?? []) as (q.ImportItemRow & { content_source: string | null })[];
const readBatch = async () =>
  (await supabaseAdmin.from("blog_import_batches").select("*").eq("id", batchId).single()).data as q.ImportBatchRow;

// Phase 1: run until nothing is claimable (the new article done, duplicates held).
async function drain(label: string) {
  for (let i = 0; i < 150; i++) {
    const ran = await q.runOneJob(origin);
    if (!ran) {
      const items = await readItems();
      const st = (await readBatch()).status;
      if (st !== "queued" && st !== "extracting" && !items.some((it) => it.status === "queued" || it.status === "processing")) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const items = await readItems();
  log(`${label}: batch=${(await readBatch()).status} items=${items.map((i) => `#${i.idx}:${i.status}`).join(" ")}`);
  return items;
}

let items = await drain("after processing");
check("3 articles found", items.length === 3, String(items.length));
const dupLive = items[0];
const fresh = items[1];
const dupInDoc = items[2];
check("duplicate of live blog is HELD", dupLive?.status === "held", dupLive?.status);
check("…and has NO draft", dupLive?.post_id === null);
check("…and points at the live blog", dupLive?.duplicate_of_post_id === live.id, dupLive?.duplicate_of_title ?? "");
check("…and no Gemini work spent", dupLive?.format_status === "pending" && dupLive?.seo_status === "pending");
check("new article processed normally", fresh?.status === "done" && !!fresh?.post_id, fresh?.status);
check("repeat inside the document is HELD", dupInDoc?.status === "held" && dupInDoc?.post_id === null, dupInDoc?.status);
check(
  "…and points at the earlier article",
  dupInDoc?.duplicate_of_post_id === fresh?.post_id && (dupInDoc?.duplicate_of_title ?? "").includes("earlier in this document"),
  dupInDoc?.duplicate_of_title ?? "",
);
check("batch NOT complete while duplicates wait", (await readBatch()).status === "processing");
check("waiting batch still shown in panel", (await q.listVisibleBatches()).some((b) => b.id === batchId));
const panelItem = (await q.listVisibleBatches()).find((b) => b.id === batchId)?.items[0] as Record<string, unknown> | undefined;
check("panel poll does not ship article text", panelItem !== undefined && !("content_source" in panelItem));

const { count: draftsBefore } = await supabaseAdmin
  .from("blog_posts")
  .select("id", { count: "exact", head: true })
  .eq("import_batch_id", batchId);
check("only 1 draft saved (the new one)", draftsBefore === 1, String(draftsBefore));

// Phase 2: Remove the live duplicate; double-remove must be refused.
const r1 = await q.resolveHeldItem(batchId, dupLive.id, "remove");
const r1again = await q.resolveHeldItem(batchId, dupLive.id, "remove");
check("Remove works", r1.ok);
check("second Remove refused (no double action)", !r1again.ok);

// Phase 3: Import the in-document repeat anyway.
const k = await q.resolveHeldItem(batchId, dupInDoc.id, "keep");
check("Import anyway works", k.ok);
items = await drain("after decisions");
const kept = items.find((i) => i.id === dupInDoc.id)!;
check("removed duplicate deleted from DB", !items.some((i) => i.id === dupLive.id), `${items.length} rows left`);
const { count: liveCopies } = await supabaseAdmin.from("blog_posts").select("id", { count: "exact", head: true }).eq("import_batch_id", batchId).eq("title", live.title);
check("removed duplicate never reached blog_posts", liveCopies === 0, String(liveCopies));
check("kept item got a draft and was processed", kept.status === "done" && !!kept.post_id, `${kept.status} ${kept.last_error ?? ""}`);
const keptPost = kept.post_id ? await getPostById(kept.post_id) : null;
check("kept draft formatted + SEO", keptPost?.format_source === "gemini" && !!keptPost?.meta_title, keptPost?.meta_title ?? "");
check("kept item still flagged for review", kept.needs_review === true);
check("batch completed once all decided", (await readBatch()).status === "completed");
check("completed batch hidden from panel", !(await q.listVisibleBatches()).some((b) => b.id === batchId));

console.log("\n=== RESULTS ===");
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
log("total time");

// Cleanup
const { data: posts } = await supabaseAdmin.from("blog_posts").select("id, cover_image_url").eq("import_batch_id", batchId);
for (const p of posts ?? []) {
  if (p.cover_image_url) await del(p.cover_image_url, { token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN }).catch(() => {});
  await deletePost(p.id);
}
await supabaseAdmin.from("blog_import_batches").delete().eq("id", batchId);
await del(blob.url, { token: blobToken() }).catch(() => {});
const stillLive = await getPostById(live.id);
console.log(`cleanup done — existing live blog untouched: ${stillLive?.status === "published"}`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
