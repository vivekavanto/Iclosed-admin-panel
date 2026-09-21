"use client";

import { sanitizeBlogHtml } from "@/lib/sanitizeBlogHtml";

/**
 * The rendered body of a blog article, as the editor's preview shows it.
 *
 * The styling deliberately covers every tag the sanitizer allows: when the
 * allowlist in sanitizeBlogHtml gains a tag and this does not, the result is
 * not an error — it is an article that quietly previews an unstyled <ol> or a
 * borderless table, and gets published that way.
 *
 * Sanitizes at the point of render, not only on save. What is on screen here
 * includes HTML the admin has typed into the "Edit HTML" box and not yet
 * saved, which has been through nothing.
 *
 * The reader-facing copy of this lives in the portal
 * (iclosed_dev_web/src/components/blog/BlogArticleBody.tsx) and is the one that
 * decides how a post actually looks to a client. This is a faithful preview,
 * not the source of truth for the published styling.
 */
export default function BlogArticleBody({
  html,
  className = "",
}: {
  html: string;
  className?: string;
}) {
  return (
    <article
      className={`
        [&_h2]:mb-4 [&_h2]:mt-10 [&_h2]:border-l-[3px] [&_h2]:border-brand-primary
        [&_h2]:pl-4 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-slate-900
        [&_h3]:mb-2 [&_h3]:mt-7 [&_h3]:text-base [&_h3]:font-bold [&_h3]:text-slate-900
        [&_h4]:mb-2 [&_h4]:mt-5 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:text-slate-800
        [&_p]:mb-4 [&_p]:text-[15px] [&_p]:leading-[1.8] [&_p]:text-slate-600
        [&_li]:text-[14.5px] [&_li]:leading-[1.75] [&_li]:text-slate-600
        [&_ul]:mb-5 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6
        [&_ol]:mb-5 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-6
        [&_strong]:font-semibold [&_strong]:text-slate-800
        [&_em]:italic
        [&_a]:font-medium [&_a]:text-brand-primary [&_a]:underline [&_a]:underline-offset-2
        [&_hr]:my-8 [&_hr]:border-slate-100
        [&_blockquote]:mb-5 [&_blockquote]:rounded-xl [&_blockquote]:border-l-4
        [&_blockquote]:border-brand-primary [&_blockquote]:bg-brand-light/40 [&_blockquote]:px-5
        [&_blockquote]:py-3 [&_blockquote]:text-[14.5px] [&_blockquote]:leading-relaxed
        [&_blockquote]:text-slate-700
        [&_figure]:mb-5
        [&_figcaption]:mt-2 [&_figcaption]:text-xs [&_figcaption]:text-slate-400
        [&_img]:rounded-xl
        [&_table]:mb-5 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm
        [&_th]:border [&_th]:border-slate-200 [&_th]:bg-slate-50 [&_th]:px-3 [&_th]:py-2
        [&_th]:text-left [&_th]:font-semibold [&_th]:text-slate-700
        [&_td]:border [&_td]:border-slate-200 [&_td]:px-3 [&_td]:py-2 [&_td]:text-slate-600
        [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[13px]
        [&_pre]:mb-5 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-slate-900 [&_pre]:p-4
        [&_pre]:text-[12.5px] [&_pre]:text-slate-100
        ${className}
      `}
      dangerouslySetInnerHTML={{ __html: sanitizeBlogHtml(html) }}
    />
  );
}
