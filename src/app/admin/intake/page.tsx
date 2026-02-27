"use client";
import React from 'react';
import dynamic from 'next/dynamic';
const Intake = dynamic(() => import('@/components/Intake').catch(() => () => <div>Intake component not available yet</div>), { ssr: false });

export default function Page() {
  return (
    <div className="p-8">
      <Intake />
    </div>
  );
}
