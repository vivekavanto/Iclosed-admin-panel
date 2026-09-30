"use client";

import BlogEditor, { EMPTY_POST } from '@/components/BlogEditor';

export default function NewBlogPostPage() {
  return <BlogEditor initial={EMPTY_POST} />;
}
