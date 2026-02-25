"use client";

import React, { useState } from "react";
import {
  History,
  Mail,
  Key,
  User as UserIcon,
  Building2,
  Check,
  ExternalLink,
  Send,
  ChevronDown,
  ShieldCheck,
  Smartphone,
  Fingerprint,
  CheckCircle2,
  Printer,
  Plus,
  ArrowLeft,
  X,
  Search,
  ArrowRight,
  MapPin,
  FileText,
  Briefcase as BriefcaseIcon,
} from "lucide-react";

interface LeadUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  isCorporate: boolean;
  corporateName?: string;
  incNumber?: string;
  addressStreet?: string;
  addressCity?: string;
  addressPostalCode?: string;
  propertyType?: string;
  ownershipHistory?: string;
  maritalStatus?: string;
  citizenshipStatus?: string;
  occupation?: string;
  employerPhone?: string;
}

const Leads: React.FC = () => {
  const [view, setView] = useState<"LIST" | "DETAIL">("LIST");
  const [selectedLead, setSelectedLead] = useState<LeadUser | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newClientType, setNewClientType] = useState<
    "residential" | "corporate"
  >("residential");

  const [expandedSections, setExpandedSections] = useState<string[]>([
    "personal",
    "current-address",
    "property-personal",
  ]);

  const [leads, setLeads] = useState<LeadUser[]>([
    {
      id: "u1",
      firstName: "Varnesh",
      lastName: "Vasudevan",
      email: "varnesh@prcoach.ca",
      phone: "4165408632",
      isCorporate: false,
      addressStreet: "10 Milner Business Court",
      addressCity: "Toronto",
      addressPostalCode: "M1B 3C6",
      propertyType: "Primary",
      ownershipHistory: "No (first time)",
      maritalStatus: "Single",
      citizenshipStatus: "Canadian Citizen",
      occupation: "Engineer",
      employerPhone: "6479977278",
    },
    {
      id: "u2",
      firstName: "Sarah",
      lastName: "Miller",
      email: "sarah@miller-assets.com",
      phone: "905-555-0122",
      isCorporate: true,
      corporateName: "Miller Asset Management Inc.",
      incNumber: "10029384",
      addressStreet: "456 Corporate Way",
      addressCity: "Mississauga",
      addressPostalCode: "L5B 2K3",
    },
  ]);

  const handleAddClient = (e: React.FormEvent) => {
    e.preventDefault();
    setIsAddModalOpen(false);
  };

  const openLead = (lead: LeadUser) => {
    setSelectedLead(lead);
    setView("DETAIL");
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  const inputClasses =
    "w-full px-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all placeholder:text-slate-300";
  const selectClasses =
    "w-full px-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all appearance-none cursor-pointer";

  const SectionHeader = ({
    title,
    id,
    icon: Icon,
  }: {
    title: string;
    id: string;
    icon: any;
  }) => (
    <button
      onClick={() => toggleSection(id)}
      className={`w-full flex items-center justify-between px-6 py-4 transition-all duration-200 border-b border-slate-100 ${
        expandedSections.includes(id) ? "bg-slate-50/50" : "hover:bg-slate-50"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`p-2 rounded-lg ${expandedSections.includes(id) ? "bg-brand-primary text-white shadow-sm" : "bg-slate-100 text-slate-500"}`}
        >
          <Icon size={18} />
        </div>
        <h3 className="font-bold text-slate-800 tracking-tight">{title}</h3>
      </div>
      <ChevronDown
        size={20}
        className={`text-slate-400 transition-transform duration-300 ${expandedSections.includes(id) ? "rotate-180" : ""}`}
      />
    </button>
  );

  if (view === "DETAIL" && selectedLead) {
    return (
      <div className="max-w-6xl mx-auto space-y-6 animate-in slide-in-from-right duration-300 py-4 pb-20">
        {/* Detail Navigation */}
        <button
          onClick={() => setView("LIST")}
          className="flex items-center gap-2 text-slate-500 font-bold text-sm hover:text-brand-primary transition-colors"
        >
          <ArrowLeft size={18} /> Back to Leads Dashboard
        </button>

        {/* Top Identity Card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-5">
            <div className="w-16 h-16 bg-brand-light rounded-2xl flex items-center justify-center text-brand-primary">
              {selectedLead.isCorporate ? (
                <Building2 size={32} />
              ) : (
                <UserIcon size={32} />
              )}
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">
                {selectedLead.isCorporate
                  ? "Corporate Entity"
                  : "Individual Profile"}
              </h1>
              <h2 className="text-2xl font-black text-slate-900 leading-none">
                {selectedLead.firstName} {selectedLead.lastName}
              </h2>
              <p className="text-slate-500 font-medium mt-1">
                {selectedLead.email}
              </p>
            </div>
          </div>
          <button className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg active:scale-95">
            <History size={14} /> View History
          </button>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Section: Personal Information */}
          <SectionHeader
            title="Personal Information"
            id="personal"
            icon={UserIcon}
          />
          {expandedSections.includes("personal") && (
            <div className="p-8 space-y-6 animate-in slide-in-from-top-2 duration-300 border-t border-slate-50">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    First Name
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    defaultValue={selectedLead.firstName}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Last Name
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    defaultValue={selectedLead.lastName}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Phone Number
                  </label>
                  <div className="relative">
                    <Smartphone
                      size={16}
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
                    />
                    <input
                      type="text"
                      className="w-full pl-11 pr-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all"
                      defaultValue={selectedLead.phone}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail
                      size={16}
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
                    />
                    <input
                      type="email"
                      className="w-full pl-11 pr-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all"
                      defaultValue={selectedLead.email}
                    />
                  </div>
                </div>
              </div>

              {selectedLead.isCorporate && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-50 animate-in slide-in-from-top-2">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                      Corporate Name
                    </label>
                    <div className="relative">
                      <Building2
                        size={16}
                        className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
                      />
                      <input
                        type="text"
                        className="w-full pl-11 pr-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all"
                        defaultValue={selectedLead.corporateName}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                      Incorporation Number
                    </label>
                    <div className="relative">
                      <Fingerprint
                        size={16}
                        className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
                      />
                      <input
                        type="text"
                        className="w-full pl-11 pr-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all"
                        defaultValue={selectedLead.incNumber}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="pt-4 flex items-center gap-4">
                <label className="relative flex items-center cursor-pointer group bg-slate-50 px-6 py-4 rounded-2xl border border-slate-100 transition-all hover:border-brand-primary/30">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    defaultChecked={selectedLead.isCorporate}
                  />
                  <div
                    className={`w-6 h-6 border-2 rounded-lg transition-all flex items-center justify-center ${
                      selectedLead.isCorporate
                        ? "bg-brand-primary border-brand-primary shadow-sm"
                        : "border-slate-300 bg-white group-hover:border-brand-primary"
                    }`}
                  >
                    {selectedLead.isCorporate && (
                      <Check size={16} className="text-white" />
                    )}
                  </div>
                  <div className="ml-4">
                    <span className="block text-sm font-bold text-slate-800 select-none leading-none">
                      Corporate Member
                    </span>
                    <span className="block text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                      Nava Wilson Authorized
                    </span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Section: Current Address */}
          <SectionHeader
            title="Current Address"
            id="current-address"
            icon={MapPin}
          />
          {expandedSections.includes("current-address") && (
            <div className="p-8 space-y-6 animate-in slide-in-from-top-2 duration-300 border-t border-slate-50">
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                  Current address street
                </label>
                <input
                  type="text"
                  className={inputClasses}
                  defaultValue={selectedLead.addressStreet}
                  placeholder="e.g. 10 Milner Business Court"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Current address city
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    defaultValue={selectedLead.addressCity}
                    placeholder="e.g. Toronto"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Current address postal code
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    defaultValue={selectedLead.addressPostalCode}
                    placeholder="e.g. M1B 3C6"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Section: Property & Personal Information */}
          <SectionHeader
            title="Property & Personal Information"
            id="property-personal"
            icon={FileText}
          />
          {expandedSections.includes("property-personal") && (
            <div className="p-8 space-y-6 animate-in slide-in-from-top-2 duration-300 border-t border-slate-50">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Current property type
                  </label>
                  <div className="relative">
                    <select
                      className={selectClasses}
                      defaultValue={selectedLead.propertyType || "Primary"}
                    >
                      <option>Primary</option>
                      <option>Investment</option>
                      <option>Vacation</option>
                      <option>Commercial</option>
                    </select>
                    <ChevronDown
                      size={14}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Property ownership history
                  </label>
                  <div className="relative">
                    <select
                      className={selectClasses}
                      defaultValue={
                        selectedLead.ownershipHistory || "No (first time)"
                      }
                    >
                      <option>No (first time)</option>
                      <option>Yes (previous owner)</option>
                      <option>Current owner</option>
                    </select>
                    <ChevronDown
                      size={14}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Marital status
                  </label>
                  <div className="relative">
                    <select
                      className={selectClasses}
                      defaultValue={selectedLead.maritalStatus || "Single"}
                    >
                      <option>Single</option>
                      <option>Married</option>
                      <option>Common Law</option>
                      <option>Divorced</option>
                      <option>Widowed</option>
                    </select>
                    <ChevronDown
                      size={14}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Citizenship status
                  </label>
                  <div className="relative">
                    <select
                      className={selectClasses}
                      defaultValue={selectedLead.citizenshipStatus || ""}
                    >
                      <option value="">---------</option>
                      <option>Canadian Citizen</option>
                      <option>Permanent Resident</option>
                      <option>Work Permit</option>
                      <option>Non-Resident</option>
                    </select>
                    <ChevronDown
                      size={14}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Occupation
                  </label>
                  <div className="relative">
                    <BriefcaseIcon
                      size={16}
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
                    />
                    <input
                      type="text"
                      className="w-full pl-11 pr-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all"
                      defaultValue={selectedLead.occupation}
                      placeholder="e.g. Engineer"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Business employer phone
                  </label>
                  <div className="relative">
                    <Smartphone
                      size={16}
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
                    />
                    <input
                      type="text"
                      className="w-full pl-11 pr-4 py-2.5 border border-slate-300 rounded-xl focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/5 outline-none text-sm font-bold text-black bg-white transition-all"
                      defaultValue={selectedLead.employerPhone}
                      placeholder="e.g. 647-997-7278"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Section: Associated Client Leads */}
          <SectionHeader
            title="Associated Client Leads"
            id="client-leads"
            icon={BriefcaseIcon}
          />
          {expandedSections.includes("client-leads") && (
            <div className="p-0 animate-in slide-in-from-top-2 duration-300 overflow-x-auto border-t border-slate-50">
              <div className="p-12 text-center text-slate-400 font-medium italic text-sm bg-slate-50/20">
                No linked transaction files for this lead yet.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500 py-4">
      {/* Header with Search and Add Button */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">
            Leads Dashboard
          </h1>
          <p className="text-slate-500 font-medium">
            Manage and onboard prospective client leads.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative">
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="text"
              placeholder="Search leads..."
              className="pl-12 pr-6 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-medium outline-none focus:border-brand-primary transition-all w-full md:w-64"
            />
          </div>
          <button
            onClick={() => setIsAddModalOpen(true)}
            className="flex items-center gap-2 px-6 py-2.5 bg-brand-primary text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-brand-primaryHover transition-all shadow-lg active:scale-95 whitespace-nowrap"
          >
            <Plus size={16} /> Add Client
          </button>
        </div>
      </div>

      {/* Leads Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-slate-50/50 border-b border-slate-200 text-[11px] font-black text-slate-400 uppercase tracking-widest">
              <th className="px-8 py-5">Client Name</th>
              <th className="px-6 py-5">Contact Details</th>
              <th className="px-6 py-5">Type</th>
              <th className="px-6 py-5">Status</th>
              <th className="px-6 py-5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {leads.map((lead) => (
              <tr
                key={lead.id}
                onClick={() => openLead(lead)}
                className="hover:bg-slate-50/50 transition-colors cursor-pointer group"
              >
                <td className="px-8 py-6">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-brand-light flex items-center justify-center text-brand-primary transition-colors group-hover:bg-brand-primary group-hover:text-white">
                      {lead.isCorporate ? (
                        <Building2 size={20} />
                      ) : (
                        <UserIcon size={20} />
                      )}
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-900 leading-none mb-1 group-hover:text-brand-primary">
                        {lead.firstName} {lead.lastName}
                      </h4>
                      {lead.isCorporate && (
                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                          {lead.corporateName}
                        </p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-6">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                      <Mail size={14} className="text-slate-300" /> {lead.email}
                    </p>
                    <p className="text-xs text-slate-400 flex items-center gap-1.5">
                      <Smartphone size={14} className="text-slate-300" />{" "}
                      {lead.phone}
                    </p>
                  </div>
                </td>
                <td className="px-6 py-6">
                  <span
                    className={`px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-tight ${
                      lead.isCorporate
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {lead.isCorporate ? "Corporate" : "Individual"}
                  </span>
                </td>
                <td className="px-6 py-6">
                  <div className="flex items-center gap-1.5 text-green-600 font-bold text-xs bg-green-50 px-2.5 py-1 rounded-full border border-green-100 w-fit">
                    <CheckCircle2 size={14} /> Active Lead
                  </div>
                </td>
                <td className="px-6 py-6 text-right">
                  <button className="p-2 text-slate-300 hover:text-brand-primary transition-colors">
                    <ArrowRight size={20} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add Client Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            onClick={() => setIsAddModalOpen(false)}
          />
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg relative z-10 overflow-hidden animate-in zoom-in duration-300">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center">
              <div>
                <h3 className="text-2xl font-black text-slate-900 leading-none">
                  Add New Client
                </h3>
                <p className="text-slate-500 font-medium mt-2">
                  Initialize a new lead file
                </p>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-slate-300 hover:text-slate-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>

            <form onSubmit={handleAddClient} className="p-8 space-y-6">
              <div className="flex p-1 bg-slate-100 rounded-2xl border border-slate-200">
                <button
                  type="button"
                  onClick={() => setNewClientType("residential")}
                  className={`flex-1 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
                    newClientType === "residential"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                >
                  Individual
                </button>
                <button
                  type="button"
                  onClick={() => setNewClientType("corporate")}
                  className={`flex-1 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
                    newClientType === "corporate"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                >
                  Corporate
                </button>
              </div>

              {newClientType === "residential" ? (
                <div className="space-y-4 animate-in fade-in">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                      Full Name *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. John Doe"
                      className={inputClasses}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                      Email Address *
                    </label>
                    <input
                      type="email"
                      placeholder="john@example.com"
                      className={inputClasses}
                      required
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4 animate-in fade-in">
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        Corporate Name *
                      </label>
                      <input
                        type="text"
                        placeholder="Enter company name"
                        className={inputClasses}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        Corporate Email *
                      </label>
                      <input
                        type="email"
                        placeholder="company@email.com"
                        className={inputClasses}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        Inc. Number
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. 1234567"
                        className={inputClasses}
                      />
                    </div>
                  </div>
                </div>
              )}

              <button
                type="submit"
                className="w-full py-4 bg-brand-primary text-white rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-[0.98]"
              >
                Create Lead Profile
              </button>
            </form>
          </div>
        </div>
      )}

      <div className="pt-8 text-center">
        <p className="text-[10px] text-slate-300 font-bold uppercase tracking-widest">
          iClosed Lead Management Tool ©2025
        </p>
      </div>
    </div>
  );
};

export default Leads;
