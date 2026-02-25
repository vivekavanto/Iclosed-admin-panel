"use client";
import React from 'react';
import DealList from '../../components/DealList';

export default function Page() {
  return (
    <div className="p-8">
      <DealList onSelectDeal={(id) => console.log('selected', id)} />
    </div>
  );
}
