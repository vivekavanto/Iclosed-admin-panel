"use client";
import React, { Suspense } from 'react';
import Leads from '@/components/Leads';

export default function Page() {
  return (
    <div className="p-8">
      <Suspense fallback={null}>
        <Leads />
      </Suspense>
    </div>
  );
}
