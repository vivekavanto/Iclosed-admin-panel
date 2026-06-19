"use client";
import React from 'react';
import DealList from '@/components/DealList';
import { useRouter } from 'next/navigation';

export default function Page() {
  const router = useRouter();

  const handleSelectDeal = (id: string) => {
    router.push(`/admin/deals/${id}`);
  };

  return (
    <div className="w-full">
      <DealList onSelectDeal={handleSelectDeal} />
    </div>
  );
}