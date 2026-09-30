"use client";

import { sanitizeBlogHtml } from "@/lib/sanitizeBlogHtml";
import { ARTICLE_BODY_CLASS } from "./articleBodyClass";

/**
 * The rendered body of a blog article.
 *
 * Shares its styling with BlogRichTextEditor through ARTICLE_BODY_CLASS, so
 * the box the admin types into and the article as rendered are the same
 * surface rather than two things that look similar today.
 *
 * Sanitizes at the point of render, not only on save. What is on screen here
 * can include HTML the admin typed into the editor's source view and has not
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
      className={`${ARTICLE_BODY_CLASS} ${className}`}
      dangerouslySetInnerHTML={{ __html: sanitizeBlogHtml(html) }}
    />
  );
}
