"use client";

import React, { useState, useEffect } from "react";
import { X, Search as SearchIcon } from "lucide-react";
import { MOCK_DEALS } from "../constants";
import { Deal, DealType } from "../types";

interface SearchDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToDeal?: (dealId: string) => void;
}

const SearchDrawer: React.FC<SearchDrawerProps> = ({
  isOpen,
  onClose,
  onNavigateToDeal = () => {},
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [recentDeals, setRecentDeals] = useState<Deal[]>([]);

  useEffect(() => {
    setRecentDeals(MOCK_DEALS.slice(0, 5));
  }, []);

  const filteredDeals = searchTerm
    ? MOCK_DEALS.filter((deal) => {
        const lowerTerm = searchTerm.toLowerCase();
        if (searchTerm.startsWith("#")) {
          return deal.fileNumber.toLowerCase().includes(lowerTerm);
        }
        return (
          deal.fileNumber.toLowerCase().includes(lowerTerm) ||
          deal.propertyAddress.toLowerCase().includes(lowerTerm) ||
          deal.client.lastName.toLowerCase().includes(lowerTerm) ||
          deal.client.firstName.toLowerCase().includes(lowerTerm)
        );
      })
    : recentDeals;

  const getTypeStyles = (type: DealType) => {
    switch (type) {
      case DealType.PURCHASE:
        return { bg: "bg-blue-700", letter: "P" };
      case DealType.SALE:
        return { bg: "bg-orange-500", letter: "S" };
      case DealType.REFINANCE:
        return { bg: "bg-brand-black", letter: "R" };
      default:
        return { bg: "bg-slate-500", letter: "?" };
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/20 z-30 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div className="fixed left-64 top-0 bottom-0 w-[420px] bg-white shadow-2xl z-40 flex flex-col border-r border-slate-200 animate-in slide-in-from-left duration-200">
        <div className="p-6 pb-2">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-slate-900">Search</h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X size={24} />
            </button>
          </div>
          <div className="relative mb-4">
            <input
              type="text"
              placeholder="Search clients or files"
              className="w-full pl-4 pr-10 py-3 border-2 border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-brand-primary focus:ring-0 transition-colors"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              autoFocus
            />
          </div>
          <div className="bg-slate-100 rounded-lg p-3 text-sm text-slate-600 mb-2">
            <span className="font-bold text-slate-800">Search hint:</span> Start
            your search with{" "}
            <span className="font-mono font-bold text-slate-900">
              &apos;#&apos;
            </span>{" "}
            to search only by file number e.g. #1234
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4 mt-2">
            {searchTerm ? "Search Results" : "Recently viewed"}
          </h3>
          <div className="space-y-3">
            {filteredDeals.length > 0 ? (
              filteredDeals.map((deal) => {
                const typeStyle = getTypeStyles(deal.type);
                return (
                  <div
                    key={deal.id}
                    onClick={() => {
                      onNavigateToDeal(deal.id);
                      onClose();
                    }}
                    className="group bg-white border border-slate-200 rounded-xl p-4 cursor-pointer hover:shadow-md hover:border-brand-primary/30 transition-all"
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`${typeStyle.bg} w-8 h-8 rounded flex items-center justify-center flex-shrink-0 mt-1`}
                      >
                        <span className="text-white font-bold text-sm">
                          {typeStyle.letter}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start">
                          <p className="text-sm font-medium text-slate-500 font-mono">
                            {deal.fileNumber}
                          </p>
                        </div>
                        <h4 className="font-bold text-slate-900 text-sm mb-1 leading-tight group-hover:text-brand-primary transition-colors">
                          {deal.propertyAddress}
                        </h4>
                        <p className="text-xs text-slate-500 truncate mb-1">
                          {deal.propertyAddress}
                        </p>
                        <div className="flex justify-end mt-2">
                          <span className="text-xs text-slate-400 font-medium">
                            KN | sa
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="text-center py-8 text-slate-400">
                <p>No results found.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default SearchDrawer;
