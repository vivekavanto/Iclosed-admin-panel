"use client";

import React, { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { notFound } from "next/navigation";
import MessagesInbox from "@/components/MessagesInbox";
import { CHAT_ENABLED } from "@/lib/chatFlag";

// /admin/messages            — the inbox
// /admin/messages?c=<lead>   — open a conversation (notification links)
// /admin/messages?deal=<id>  — "Message this client" from a deal page

function Inner() {
  const params = useSearchParams();
  const conversation = params.get("c");
  const deal = params.get("deal");
  const [resolved, setResolved] = useState<string | null>(conversation);
  const [ready, setReady] = useState(!deal || !!conversation);

  useEffect(() => {
    if (conversation || !deal) return;
    fetch(`/api/admin/messages?deal_id=${encodeURIComponent(deal)}`)
      .then((r) => r.json())
      .then((j) => setResolved(j?.root ?? null))
      .catch(() => {})
      .finally(() => setReady(true));
  }, [conversation, deal]);

  if (!ready) return null;
  return <MessagesInbox key={resolved ?? "none"} initialId={resolved} />;
}

export default function Page() {
  if (!CHAT_ENABLED) notFound();
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
