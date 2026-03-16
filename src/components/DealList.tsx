import React, { useState, useEffect } from 'react';
import { Deal, DealType, DealStatus } from '../types';
import { Search } from 'lucide-react';

interface DealListProps {
  onSelectDeal?: (dealId: string) => void;
}

const DealList: React.FC<DealListProps> = ({ onSelectDeal = () => { } }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('All');
  const [filterStatus, setFilterStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [deals, setDeals] = useState<Deal[]>([]);

  useEffect(() => {
    fetch('/api/admin/deals')
      .then(res => res.json())
      .then((data: any[]) => {
        const mapped: Deal[] = (data || []).map((d: any) => ({
          id: d.id,
          fileNumber: d.fileNumber ?? d.file_number ?? '',
          client: d.client ?? { id: '', firstName: '', lastName: d.client_last_name ?? '', email: '', phone: '' },
          type: d.type,
          status: d.status,
          propertyAddress: d.propertyAddress ?? d.property_address ?? '',
          closingDate: d.closingDate ?? d.closing_date ?? '',
          openingDate: d.openingDate ?? d.opening_date,
          requisitionDate: d.requisitionDate ?? d.requisition_date,
          price: d.price ?? 0,
          progress: d.progress ?? 0,
          tasks: d.tasks ?? [],
          milestones: d.milestones ?? [],
          documents: d.documents ?? [],
          notes: d.notes ?? [],
        }));
        setDeals(mapped);
      })
      .catch(() => setDeals([]));
  }, []);

  const countS = deals.filter(d => d.type === DealType.SALE).length;
  const countP = deals.filter(d => d.type === DealType.PURCHASE).length;
  const countR = deals.filter(d => d.type === DealType.REFINANCE).length;
  const totalFiles = deals.length;

  const filteredDeals = deals.filter(deal => {
    if (searchTerm) {
      const lowerTerm = searchTerm.toLowerCase();
      const matchesSearch =
        deal.fileNumber.toLowerCase().includes(lowerTerm) ||
        deal.propertyAddress.toLowerCase().includes(lowerTerm) ||
        deal.type?.toLowerCase().includes(lowerTerm) ||
        deal.status?.toLowerCase().includes(lowerTerm);
      if (!matchesSearch) return false;
    }
    if (filterType && filterType !== 'All' && deal.type !== filterType) return false;
    if (filterStatus && filterStatus !== '' && deal.status !== filterStatus) return false;
    if (dateFrom || dateTo) {
      const closing = deal.closingDate ? new Date(deal.closingDate) : null;
      if (!closing) return false;
      closing.setHours(0, 0, 0, 0);
      if (dateFrom) { const from = new Date(dateFrom); from.setHours(0,0,0,0); if (closing < from) return false; }
      if (dateTo) { const to = new Date(dateTo); to.setHours(23,59,59,999); if (closing > to) return false; }
    }
    return true;
  });

  const applyPreset = (preset: 'today' | 'week' | 'month') => {
    const now = new Date();
    const toISO = (d: Date) => d.toISOString().split('T')[0];
    if (preset === 'today') {
      setDateFrom(toISO(now));
      setDateTo(toISO(now));
    } else if (preset === 'week') {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      setDateFrom(toISO(start));
      setDateTo(toISO(end));
    } else if (preset === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      setDateFrom(toISO(start));
      setDateTo(toISO(end));
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200">
      <div className="flex flex-col xl:flex-row items-start xl:items-center justify-between p-6 pb-2 gap-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-slate-900 border-b-2 border-slate-900 pb-0.5">All files</h1>
          <div className="flex items-center gap-2 text-sm"><span className="font-bold text-slate-700">Total files: {totalFiles}</span><span className="bg-orange-100 text-orange-700 border border-orange-200 px-1.5 rounded text-xs font-bold" title="Sales">S {countS}</span><span className="bg-blue-100 text-blue-700 border border-blue-200 px-1.5 rounded text-xs font-bold" title="Purchases">P {countP}</span><span className="bg-brand-black text-white px-1.5 rounded text-xs font-bold" title="Refinances">R {countR}</span></div>
        </div>

        <div className="flex flex-1 w-full xl:w-auto items-center gap-3 justify-end">
          <div className="relative flex-1 xl:flex-none xl:w-96">
            <input type="text" placeholder="Search" className="w-full pl-3 pr-4 py-1.5 border border-slate-300 rounded text-sm focus:outline-none focus:border-brand-primary" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="px-6 pb-6 pt-2 space-y-4">
        <div className="flex flex-wrap items-end gap-6 border-b border-slate-100 pb-4">
          <div className="flex border border-slate-300 rounded overflow-hidden"><button className="px-3 py-1.5 text-xs font-medium transition-colors bg-brand-light text-brand-primary cursor-default">Closing date</button></div>
          <div className="flex items-center gap-3">
            <div><label className="block text-xs text-slate-500 mb-1">From</label><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 focus:border-brand-primary outline-none" /></div>
            <div><label className="block text-xs text-slate-500 mb-1">To</label><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 focus:border-brand-primary outline-none" /></div>
            {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="text-xs text-slate-400 hover:text-red-500 pb-0.5 mt-4">✕ Clear</button>}
          </div>
          <div className="flex gap-4 pb-1"><button onClick={() => applyPreset('today')} className="text-xs font-medium text-brand-primary hover:underline">Today</button><button onClick={() => applyPreset('week')} className="text-xs font-medium text-brand-primary hover:underline">This week</button><button onClick={() => applyPreset('month')} className="text-xs font-medium text-brand-primary hover:underline">This month</button></div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div><label className="block text-xs text-slate-500 mb-1">File type</label><select value={filterType} onChange={e => setFilterType(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"><option value="All">All</option><option value="Purchase">Purchase</option><option value="Sale">Sale</option><option value="Refinance">Refinance</option></select></div>
          <div><label className="block text-xs text-slate-500 mb-1">Lawyer</label><select className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"><option>Choose a lawyer</option></select></div>
          <div><label className="block text-xs text-slate-500 mb-1">Clerk</label><select className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"><option>Suganya Argeen</option></select></div>
          <div><label className="block text-xs text-slate-500 mb-1">File status</label><select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"><option value="">Choose a status</option><option value="Active">Active</option><option value="Closed">Closed</option></select></div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-t border-slate-200">
          <thead>
            <tr className="bg-white text-slate-800 text-xs font-bold border-b border-slate-200">
              <th className="px-4 py-3 w-12">No.</th>
              <th className="px-4 py-3 w-24">File No.</th>
              <th className="px-4 py-3">File name</th>
              <th className="px-4 py-3 w-20">Lawyer</th>
              <th className="px-4 py-3 w-20">Clerk</th>
              <th className="px-4 py-3 w-64">Address</th>
              <th className="px-4 py-3 w-32">Closing date</th>
              <th className="px-4 py-3 w-32">Requisition date</th>
              <th className="px-4 py-3 w-32">File status</th>
            </tr>
          </thead>
          <tbody>
            {filteredDeals.length > 0 ? filteredDeals.map((deal, index) => {
              const isEven = index % 2 === 0;
              const rowClass = isEven ? 'bg-white' : 'bg-slate-50/80';
              return (
                <tr key={deal.id} onClick={() => {
                  console.log("Clicked deal id:", deal.id);
                  onSelectDeal(deal.id);
                }} className={`${rowClass} hover:bg-brand-light/20 cursor-pointer transition-colors border-b border-slate-100 text-xs text-slate-700`}>
                  <td className="px-4 py-3">{index + 1}</td>
                  <td className="px-4 py-3 font-medium">{deal.fileNumber}</td>
                  <td className="px-4 py-3">{deal.propertyAddress}</td>
                  <td className="px-4 py-3"><span className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[10px] font-bold border border-blue-100">KN</span></td>
                  <td className="px-4 py-3"><span className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[10px] font-bold border border-blue-100">SA</span></td>
                  <td className="px-4 py-3 truncate max-w-xs" title={deal.propertyAddress}>{deal.propertyAddress}</td>
                  <td className="px-4 py-3">{formatDate(deal.closingDate)}</td>
                  <td className="px-4 py-3">{formatDate(deal.requisitionDate)}</td>
                  <td className="px-4 py-3">{deal.status === DealStatus.CLOSED ? (<span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 border border-green-200 shadow-sm"><span className="mr-1">✓</span> Closed</span>) : (<span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-white text-green-600 border border-green-400">Active</span>)}</td>
                </tr>
              );
            }) : (
              <tr><td colSpan={9} className="px-6 py-12 text-center text-slate-500"><p>No files found.</p></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default DealList;
