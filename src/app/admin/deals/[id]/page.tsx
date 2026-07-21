"use client";
import React, { use, useCallback, useEffect, useState } from 'react';
import DealDetail from '@/components/DealDetail';
import { Deal } from '@/types';

interface Props { params: Promise<{ id: string }> }

export default function Page({ params }: Props) {
  const { id } = use(params);
  const [deal, setDeal] = useState<Deal | null>(null);
  const [rawDeal, setRawDeal] = useState<Record<string, any> | null>(null);

  // Exposed to DealDetail as onDealChanged so an edit that lands on a table
  // this row is JOINed from (e.g. the client's name, which saves to `leads`,
  // not `deals`) can pull the fresh row. Without it the page would keep
  // rendering the mount-time snapshot until a manual reload.
  const loadDeal = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/deals/${id}`);
      const d: any = await res.json();
      if (!d || d.error) return;
      setRawDeal(d);
      const mapped: Deal = {
        id: d.id,
        fileNumber: d.fileNumber ?? d.file_number ?? '',
        client: d.client ?? { id: '', firstName: '', lastName: d.client_last_name ?? '', email: '', phone: '' },
        type: d.type,
        status: d.status,
        propertyAddress: d.propertyAddress ?? d.property_address ?? '',
        sellingPropertyAddress: d.sellingPropertyAddress ?? d.selling_property_address ?? '',
        closingDate: d.closingDate ?? d.closing_date ?? '',
        openingDate: d.openingDate ?? d.opening_date,
        requisitionDate: d.requisitionDate ?? d.requisition_date,
        price: d.price ?? 0,
        progress: d.progress ?? 0,
        tasks: d.tasks ?? [],
        milestones: d.milestones ?? [],
        documents: d.documents ?? [],
        notes: d.notes ?? [],
      };
      setDeal(mapped);
    } catch {
      // Non-blocking — on a refresh failure the page keeps the values it has.
    }
  }, [id]);

  useEffect(() => {
    void loadDeal();
  }, [loadDeal]);

  if (!deal) {
    return <div className="p-8 text-slate-500 text-sm">Loading...</div>;
  }

  return (
    <div className="p-8">
      <DealDetail
        deal={deal}
        rawDeal={rawDeal}
        onDealChanged={loadDeal}
        onBack={() => window.history.back()}
      />
    </div>
  );
}
