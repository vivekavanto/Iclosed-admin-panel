"use client";

import React, { useState } from "react";
import Link from "next/link";
import { MOCK_DEALS } from "../constants";
import { DealType, DealStatus } from "../types";
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Calendar as CalendarIcon,
  Filter,
} from "lucide-react";

const Dashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState("All");
  const [viewedTab, setViewedTab] = useState("All");

  // Specific data slicing to match the visual layout
  const topDeals = MOCK_DEALS.slice(0, 3);
  const recentlyViewed = MOCK_DEALS.slice(3, 6);
  const upcomingRequisitions = MOCK_DEALS.slice(6, 9);

  const getTypeColor = (type: DealType) => {
    switch (type) {
      case DealType.PURCHASE:
        return "bg-brand-black";
      case DealType.SALE:
        return "bg-brand-primary"; // iClosed Red
      case DealType.REFINANCE:
        return "bg-slate-500";
      default:
        return "bg-gray-500";
    }
  };

  const getTypeLetter = (type: DealType) => {
    switch (type) {
      case DealType.PURCHASE:
        return "P";
      case DealType.SALE:
        return "S";
      case DealType.REFINANCE:
        return "R";
      default:
        return "?";
    }
  };

  const renderDealRow = (deal: any, showDueDate = false) => (
    <Link
      href={`/deals/${deal.id}`}
      key={deal.id}
      className="bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between hover:shadow-md transition-shadow cursor-pointer mb-3 group block"
    >
      <div className="flex items-center space-x-4 overflow-hidden">
        <div
          className={`w-10 h-10 ${getTypeColor(deal.type)} rounded-md flex items-center justify-center text-white font-bold text-lg flex-shrink-0 transition-colors`}
        >
          {getTypeLetter(deal.type)}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-slate-500 font-mono mb-0.5">
            {deal.fileNumber}
          </p>
          <h4 className="text-sm font-bold text-slate-800 truncate pr-4 group-hover:text-brand-primary transition-colors">
            {deal.propertyAddress}
          </h4>
          {showDueDate && deal.tasks[0] && (
            <p className="text-xs text-slate-500 mt-1">
              Due: {deal.tasks[0].dueDate}
            </p>
          )}
          {!showDueDate && (
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              {deal.propertyAddress.split("of ")[1] || "Toronto, ON"}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center space-x-4 flex-shrink-0">
        <div className="text-right hidden sm:block">
          <span className="text-xs text-slate-400 uppercase tracking-wider">
            KN | sa
          </span>
        </div>
        {deal.status === DealStatus.ACTIVE && (
          <div className="flex items-center px-3 py-1 rounded-full border border-slate-200 bg-white">
            <span className="text-xs font-medium text-slate-700 mr-2">
              Active
            </span>
            <div className="w-2 h-2 rounded-full bg-brand-primary"></div>
          </div>
        )}
        {deal.status === DealStatus.PENDING && (
          <div className="flex items-center px-3 py-1 rounded-full border border-slate-200 bg-white">
            <span className="text-xs font-medium text-slate-700 mr-2">
              Pending
            </span>
            <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
          </div>
        )}
        {deal.status === DealStatus.URGENT && (
          <div className="flex items-center px-3 py-1 rounded-full border border-red-200 bg-red-50">
            <span className="text-xs font-medium text-red-700 mr-2">
              Urgent
            </span>
            <div className="w-2 h-2 rounded-full bg-red-500"></div>
          </div>
        )}
      </div>
    </Link>
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-slate-800">
          Good afternoon, Suganya!
        </h1>
        <div className="relative">
          <button className="flex items-center space-x-2 bg-white border border-slate-200 text-sm font-medium px-4 py-2 rounded-lg text-slate-700 hover:border-brand-primary hover:text-brand-primary transition-colors">
            <span className="text-slate-400">View as</span>
            <span className="text-slate-900">All</span>
            <ChevronRight className="rotate-90 ml-2 h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* Left Column: Calendar & Stats */}
        <div className="xl:col-span-3 space-y-6">
          {/* Calendar Widget */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-bold text-slate-800 flex items-center">
                <CalendarIcon size={18} className="mr-2 text-brand-primary" />
                Feb 5, 2026
              </h2>
            </div>
            {/* Simple static calendar representation for layout fidelity */}
            <div className="w-full">
              <div className="flex justify-between mb-4">
                <span className="text-sm font-bold text-slate-800">
                  2/5/2026
                </span>
                <div className="flex space-x-2">
                  <ChevronLeft
                    size={16}
                    className="text-slate-400 hover:text-brand-primary cursor-pointer"
                  />
                  <ChevronRight
                    size={16}
                    className="text-slate-400 hover:text-brand-primary cursor-pointer"
                  />
                </div>
              </div>
              <div className="grid grid-cols-7 gap-2 text-center text-xs mb-2 text-slate-400">
                <div>S</div>
                <div>M</div>
                <div>T</div>
                <div>W</div>
                <div>T</div>
                <div>F</div>
                <div>S</div>
              </div>
              <div className="grid grid-cols-7 gap-2 text-center text-sm text-slate-700 font-medium">
                <div className="text-slate-300">1</div>
                <div className="text-slate-300">2</div>
                <div className="text-slate-300">3</div>
                <div className="w-8 h-8 flex items-center justify-center rounded-full border border-slate-200 mx-auto hover:bg-slate-50">
                  4
                </div>
                <div className="w-8 h-8 flex items-center justify-center rounded-full bg-brand-primary text-white mx-auto shadow-md shadow-brand-primary/30">
                  5
                </div>
                <div className="mx-auto pt-1">6</div>
                <div className="mx-auto pt-1">7</div>
              </div>
              {/* Weeks */}
              <div className="grid grid-cols-7 gap-2 text-center text-sm text-slate-700 font-medium mt-3">
                <div>8</div>
                <div>9</div>
                <div>10</div>
                <div>11</div>
                <div>12</div>
                <div>13</div>
                <div>14</div>
              </div>
              <div className="grid grid-cols-7 gap-2 text-center text-sm text-slate-700 font-medium mt-3">
                <div>15</div>
                <div>16</div>
                <div>17</div>
                <div>18</div>
                <div>19</div>
                <div>20</div>
                <div>21</div>
              </div>
              <div className="grid grid-cols-7 gap-2 text-center text-sm text-slate-700 font-medium mt-3">
                <div>22</div>
                <div>23</div>
                <div>24</div>
                <div>25</div>
                <div>26</div>
                <div>27</div>
                <div>28</div>
              </div>
            </div>
          </div>

          {/* Stats Cards */}
          <div className="space-y-4">
            <div className="bg-brand-primary text-white p-6 rounded-xl shadow-lg shadow-brand-primary/20 flex flex-col justify-center items-center h-28 relative overflow-hidden group transition-all hover:scale-[1.02]">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-white opacity-10 rounded-full group-hover:scale-110 transition-transform"></div>
              <span className="text-4xl font-bold mb-1">3</span>
              <span className="text-sm font-medium opacity-90">Closings</span>
            </div>
            <div className="bg-white border-2 border-brand-primary p-6 rounded-xl flex flex-col justify-center items-center h-28 text-brand-primary hover:bg-brand-light/20 transition-colors">
              <span className="text-4xl font-bold mb-1">0</span>
              <span className="text-sm font-medium">Requisitions</span>
            </div>
            <div className="bg-white border-2 border-brand-primary p-6 rounded-xl flex flex-col justify-center items-center h-28 text-brand-primary hover:bg-brand-light/20 transition-colors">
              <span className="text-4xl font-bold mb-1">0</span>
              <span className="text-sm font-medium">Appointments</span>
            </div>
          </div>
        </div>

        {/* Right Column: Active Deals List */}
        <div className="xl:col-span-9">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 h-full p-6">
            {/* Tabs */}
            <div className="flex items-center space-x-6 border-b border-slate-100 pb-4 mb-6">
              {["All (3)", "Purchases (1)", "Refinances (1)", "Sales (1)"].map(
                (tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`text-sm font-bold pb-1 transition-colors ${
                      activeTab === tab
                        ? "text-brand-primary border-b-2 border-brand-primary"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    {tab}
                  </button>
                ),
              )}
            </div>

            {/* List */}
            <div className="space-y-1">
              {topDeals.map((deal) => renderDealRow(deal))}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recently Viewed */}
        <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
          <h3 className="text-lg font-bold text-slate-800 mb-4">
            Recently viewed
          </h3>
          <div className="flex items-center space-x-4 mb-4">
            {["All (10)", "Purchases (4)", "Refinances (3)", "Sales (3)"].map(
              (tab) => (
                <button
                  key={tab}
                  onClick={() => setViewedTab(tab)}
                  className={`text-xs font-bold pb-1 transition-colors ${
                    viewedTab === tab
                      ? "text-brand-primary border-b-2 border-brand-primary"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                >
                  {tab}
                </button>
              ),
            )}
          </div>
          <div>{recentlyViewed.map((deal) => renderDealRow(deal))}</div>
        </div>

        {/* Upcoming Requisitions */}
        <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
          <h3 className="text-lg font-bold text-slate-800 mb-4">
            Upcoming requisitions
          </h3>
          <div className="flex items-center space-x-4 mb-4">
            {["Purchases (3)", "Sales (1)"].map((tab) => (
              <button
                key={tab}
                className={`text-xs font-bold pb-1 transition-colors ${
                  tab.includes("Purchases")
                    ? "text-brand-primary border-b-2 border-brand-primary"
                    : "text-slate-400 hover:text-slate-600"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
          <div>
            {upcomingRequisitions.map((deal) => renderDealRow(deal, true))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
