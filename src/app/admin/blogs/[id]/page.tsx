"use client";

import React, { use, useEffect, useState } from 'react';
import BlogEditor, { toEditorPost, type EditorPost } from '@/components/BlogEditor';

interface Props { params: Promise<{ id: string }> }

export default function EditBlogPostPage({ params }: Props) {
  const { id } = use(params);
  const [post, setPost] = useState<EditorPost | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/blog/${id}`);
        const data = await res.json();
        if (cancelled) return;
        if (data?.success) setPost(toEditorPost(data.post));
        else setError(data?.error ?? 'Could not load this post.');
      } catch {
        if (!cancelled) setError('Could not reach the server.');
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (error) {
    return <div className="p-8 text-sm text-red-600">{error}</div>;
  }
  if (!post) {
    return <div className="p-8 text-slate-500 text-sm">Loading…</div>;
  }

  // Keyed on the row id so navigating between two posts remounts the editor
  // rather than leaving the previous post's text in its state.
  return <BlogEditor key={post.id} initial={post} />;
}
