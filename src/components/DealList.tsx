import React, { useState } from 'react';
import { MOCK_DEALS } from '../constants';
import { Deal, DealType, DealStatus } from '../types';
import { Search } from 'lucide-react';

interface DealListProps {
  onSelectDeal?: (dealId: string) => void;
}

const DealList: React.FC<DealListProps> = ({ onSelectDeal = () => {} }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const countS = MOCK_DEALS.filter(d => d.type === DealType.SALE).length;
  const countP = MOCK_DEALS.filter(d => d.type === DealType.PURCHASE).length;
  const countR = MOCK_DEALS.filter(d => d.type === DealType.REFINANCE).length;
  const totalFiles = MOCK_DEALS.length;

  const filteredDeals = MOCK_DEALS.filter(deal => {
    if (!searchTerm) return true;
    const lowerTerm = searchTerm.toLowerCase();
    return (deal.fileNumber.toLowerCase().includes(lowerTerm) || deal.propertyAddress.toLowerCase().includes(lowerTerm) || deal.client.lastName.toLowerCase().includes(lowerTerm));
  });

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
               <div><label className="block text-xs text-slate-500 mb-1">From</label><input type="date" className="border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 focus:border-brand-primary outline-none" defaultValue="2026-02-01" /></div>
               <div><label className="block text-xs text-slate-500 mb-1">To</label><input type="date" className="border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 focus:border-brand-primary outline-none" defaultValue="2026-02-07" /></div>
            </div>
            <div className="flex gap-4 pb-1"><button className="text-xs font-medium text-brand-primary hover:underline">Today</button><button className="text-xs font-medium text-brand-primary hover:underline">This week</button><button className="text-xs font-medium text-brand-primary hover:underline">This month</button></div>
         </div>

         <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div><label className="block text-xs text-slate-500 mb-1">File type</label><select className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"><option>All</option><option>Purchase</option><option>Sale</option><option>Refinance</option></select></div>
            <div><label className="block text-xs text-slate-500 mb-1">Lawyer</label><select className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"><option>Choose a lawyer</option></select></div>
            <div><label className="block text-xs text-slate-500 mb-1">Clerk</label><select className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"><option>Suganya Argeen</option></select></div>
            <div><label className="block text-xs text-slate-500 mb-1">File status</label><select className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"><option>Choose a status</option><option>Active</option><option>Closed</option></select></div>
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
                <tr key={deal.id} onClick={() => onSelectDeal(deal.id)} className={`${rowClass} hover:bg-brand-light/20 cursor-pointer transition-colors border-b border-slate-100 text-xs text-slate-700`}>
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
