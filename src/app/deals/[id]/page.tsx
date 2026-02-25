"use client";
import React from 'react';
import DealDetail from '../../../components/DealDetail';
import { MOCK_DEALS } from '../../../constants';

interface Props { params: { id: string } }

export default async function Page({ params }: Props) {
  const deal = await MOCK_DEALS.find(d => d.id === params.id) || MOCK_DEALS[0];
  return (
    <div className="p-8">
      <DealDetail deal={deal} onBack={() => window.history.back()} />
    </div>
  );
}
