"use client";

import React, { useState } from 'react';
import { 
  User, 
  Building2, 
  ArrowRight, 
  ClipboardCheck, 
  Info, 
  CheckCircle2, 
  ChevronLeft,
  ShoppingBag,
  Home,
  FileText,
  Plus,
  Calendar,
  Check,
  Clock,
  Upload,
  X,
  FileUp,
  ChevronDown
} from 'lucide-react';

type Step = 'SERVICE' | 'SUB_SERVICE' | 'CLIENT_TYPE' | 'PRICE' | 'ADDRESS' | 'APS' | 'CONTACT' | 'TASKS' | 'SCHEDULE' | 'SUCCESS';

interface CorporateDoc {
  id: string;
  type: 'Article of Incorporation' | 'Corporation Profile' | 'Special Shareholder Agreement' | 'Directors Resolution' | 'Other';
  customType?: string;
  file: File | null;
}

interface IntakeState {
  service: 'closing' | 'refinance' | 'condo' | null;
  subService: 'buying' | 'selling' | 'both' | null;
  clientType: 'residential' | 'corporate' | null;
  price: string;
  address: {
    street: string;
    unit: string;
    city: string;
    postalCode: string;
    province: string;
  };
  apsSigned: 'yes' | 'no' | null;
  contact: {
    fullName: string;
    email: string;
    phone: string;
  };
  corporate: {
    name: string;
    incorporationNumber: string;
    jurisdiction: string;
    email: string;
  };
  corporateDocs: CorporateDoc[];
}

const Intake: React.FC = () => {
  const [currentStep, setCurrentStep] = useState<Step>('SERVICE');
  const [data, setData] = useState<IntakeState>({
    service: null,
    subService: null,
    clientType: null,
    price: '',
    address: { street: '', unit: '', city: '', postalCode: '', province: 'Ontario' },
    apsSigned: null,
    contact: { fullName: '', email: '', phone: '' },
    corporate: { name: '', incorporationNumber: '', jurisdiction: '', email: '' },
    corporateDocs: []
  });

  const nextStep = () => {
    const steps: Step[] = [
      "SERVICE",
      "SUB_SERVICE",
      "CLIENT_TYPE",
      "PRICE",
      "ADDRESS",
      "APS",
      "CONTACT",
      "TASKS",
      "SCHEDULE",
      "SUCCESS",
    ];
    const currentIndex = steps.indexOf(currentStep);

    if (currentStep === "CONTACT" && data.clientType !== "corporate") {
      setCurrentStep("SCHEDULE");
      return;
    }

    if (currentIndex < steps.length - 1) {
      setCurrentStep(steps[currentIndex + 1]);
    }
  };

  const prevStep = () => {
    const steps: Step[] = [
      "SERVICE",
      "SUB_SERVICE",
      "CLIENT_TYPE",
      "PRICE",
      "ADDRESS",
      "APS",
      "CONTACT",
      "TASKS",
      "SCHEDULE",
      "SUCCESS",
    ];
    const currentIndex = steps.indexOf(currentStep);

    if (currentStep === "SCHEDULE" && data.clientType !== "corporate") {
      setCurrentStep("CONTACT");
      return;
    }

    if (currentIndex > 0) {
      setCurrentStep(steps[currentIndex - 1]);
    }
  };

  const addDocField = () => {
    setData({
      ...data,
      corporateDocs: [
        ...data.corporateDocs,
        {
          id: Math.random().toString(36).substr(2, 9),
          type: "Article of Incorporation",
          file: null,
        },
      ],
    });
  };

  const removeDocField = (id: string) => {
    setData({
      ...data,
      corporateDocs: data.corporateDocs.filter((d) => d.id !== id),
    });
  };

  const updateDoc = (id: string, updates: Partial<CorporateDoc>) => {
    setData({
      ...data,
      corporateDocs: data.corporateDocs.map((d) =>
        d.id === id ? { ...d, ...updates } : d,
      ),
    });
  };

  const CardOption = ({
    title,
    description,
    icon,
    selected,
    onClick,
    price,
  }: any) => (
    <div
      onClick={onClick}
      className={`relative flex flex-col p-6 rounded-xl border-2 cursor-pointer transition-all duration-300 h-full ${
        selected
          ? "border-brand-primary bg-white shadow-lg"
          : "border-slate-100 bg-white hover:border-slate-200"
      }`}
    >
      <div className="flex justify-between items-start mb-4">
        <div className="text-brand-primary">{icon}</div>
        <div
          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
            selected
              ? "bg-brand-primary border-brand-primary"
              : "border-slate-300"
          }`}
        >
          {selected && <Check size={12} className="text-white" />}
        </div>
      </div>
      <h3 className="text-lg font-bold text-slate-900 mb-2">
        {title} {price && `- ${price}`}
      </h3>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
    </div>
  );

  const StepWrapper = ({
    title,
    subtitle,
    children,
    showBack = true,
    nextLabel = "Next",
  }: any) => (
    <div className="max-w-4xl mx-auto bg-white border border-rose-100 rounded-lg overflow-hidden min-h-[500px] flex flex-col shadow-sm">
      <div className="p-10 flex-1">
        <h2 className="text-3xl font-bold text-slate-900 mb-2">{title}</h2>
        {subtitle && <p className="text-slate-500 mb-8">{subtitle}</p>}
        {children}
      </div>
      <div className="px-10 py-6 bg-white border-t border-slate-50 flex justify-between items-center">
        {showBack ? (
          <button
            onClick={prevStep}
            className="flex items-center gap-2 px-6 py-2.5 rounded-lg border border-slate-200 text-slate-500 font-bold text-sm hover:bg-slate-50 transition-colors"
          >
            <ChevronLeft size={18} /> Previous
          </button>
        ) : (
          <div></div>
        )}
        <button
          onClick={nextStep}
          disabled={
            (currentStep === "SERVICE" && !data.service) ||
            (currentStep === "SUB_SERVICE" && !data.subService) ||
            (currentStep === "CLIENT_TYPE" && !data.clientType) ||
            (currentStep === "APS" && !data.apsSigned) ||
            (currentStep === "CLIENT_TYPE" &&
              data.clientType === "corporate" &&
              (!data.corporate.name || !data.corporate.email))
          }
          className="px-10 py-2.5 rounded-lg font-bold text-sm transition-all shadow-md active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed bg-brand-primary text-white hover:bg-brand-primaryHover"
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );

  const inputClasses =
    "w-full px-4 py-3 border border-slate-300 rounded-xl outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary bg-white text-black font-medium placeholder:text-slate-400 transition-all";

  const renderStep = () => {
    switch (currentStep) {
      case "SERVICE":
        return (
          <StepWrapper
            title="How can we assist you today?"
            subtitle="Let's start by selecting the service you need so we can get things moving."
            showBack={false}
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <CardOption
                title="Property Closing"
                description="Buying or selling a property? We'll guide you through the legal process—start to finish, and beyond."
                icon={<ShoppingBag size={32} />}
                selected={data.service === "closing"}
                onClick={() => setData({ ...data, service: "closing" })}
              />
              <CardOption
                title="Mortgage Refinance"
                description="Changing your current mortgage? Count on us to handle the legal side, smoothly and efficiently."
                icon={<Home size={32} />}
                selected={data.service === "refinance"}
                onClick={() => setData({ ...data, service: "refinance" })}
              />
              <CardOption
                title="Condo Status Certificate Report"
                description="Closing on a condo? We'll review your status certificate thoroughly—at no extra charge."
                icon={<FileText size={32} />}
                selected={data.service === "condo"}
                onClick={() => setData({ ...data, service: "condo" })}
              />
            </div>
          </StepWrapper>
        );

      case "SUB_SERVICE":
        return (
          <StepWrapper
            title="How can we assist you today?"
            subtitle="Let's start by selecting the service you need so we can get things moving."
          >
            <div className="grid grid-cols-1 gap-4">
              <div
                onClick={() => setData({ ...data, subService: "buying" })}
                className={`p-6 border rounded-xl flex items-center justify-between cursor-pointer transition-all ${data.subService === "buying" ? "border-brand-primary shadow-sm" : "border-slate-100 bg-white"}`}
              >
                <div>
                  <h4 className="font-bold text-slate-900">
                    I am buying a property - $1029
                  </h4>
                  <p className="text-xs text-slate-400">
                    You&apos;re buying a property? We&apos;ll handle the legal
                    steps to complete your purchase securely.
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 ${data.subService === "buying" ? "bg-brand-primary border-brand-primary" : "border-slate-300"}`}
                ></div>
              </div>
              <div
                onClick={() => setData({ ...data, subService: "selling" })}
                className={`p-6 border rounded-xl flex items-center justify-between cursor-pointer transition-all ${data.subService === "selling" ? "border-brand-primary shadow-sm" : "border-slate-100 bg-white"}`}
              >
                <div>
                  <h4 className="font-bold text-slate-900">
                    I am selling a property - $1029
                  </h4>
                  <p className="text-xs text-slate-400">
                    Selling a property? We&apos;ll prepare your documents and
                    manage the legal side of your sale.
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 ${data.subService === "selling" ? "bg-brand-primary border-brand-primary" : "border-slate-300"}`}
                ></div>
              </div>
              <div
                onClick={() => setData({ ...data, subService: "both" })}
                className={`p-6 border rounded-xl flex items-center justify-between cursor-pointer transition-all ${data.subService === "both" ? "border-brand-primary shadow-sm" : "border-slate-100 bg-white"}`}
              >
                <div>
                  <h4 className="font-bold text-slate-900">
                    I am buying AND selling a property - $1999
                  </h4>
                  <p className="text-xs text-slate-400">
                    Doing both? iClosed will coordinate both ends to ensure a
                    smooth and connected closing.
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 ${data.subService === "both" ? "bg-brand-primary border-brand-primary" : "border-slate-300"}`}
                ></div>
              </div>
            </div>
          </StepWrapper>
        );

      case "CLIENT_TYPE":
        return (
          <StepWrapper
            title="Who is the primary client for this file?"
            subtitle="Select whether the transaction is for an individual or a registered business entity."
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <CardOption
                title="Residential Individual"
                description="Standard purchase, sale, or refinance for a private person or couple."
                icon={<User size={32} />}
                selected={data.clientType === "residential"}
                onClick={() => setData({ ...data, clientType: "residential" })}
              />
              <CardOption
                title="Corporate Entity"
                description="Commercial or high-volume files involving a registered corporation or business."
                icon={<Building2 size={32} />}
                selected={data.clientType === "corporate"}
                onClick={() => setData({ ...data, clientType: "corporate" })}
              />
            </div>
            {data.clientType === "corporate" && (
              <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in slide-in-from-top-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    Corporate Name *
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    placeholder="Enter company name"
                    value={data.corporate.name}
                    onChange={(e) =>
                      setData({
                        ...data,
                        corporate: { ...data.corporate, name: e.target.value },
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    Corporate Email *
                  </label>
                  <input
                    type="email"
                    className={inputClasses}
                    placeholder="company@email.com"
                    value={data.corporate.email}
                    onChange={(e) =>
                      setData({
                        ...data,
                        corporate: { ...data.corporate, email: e.target.value },
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    Inc. Number
                  </label>
                  <input
                    type="text"
                    className={inputClasses}
                    placeholder="e.g. 1234567"
                    value={data.corporate.incorporationNumber}
                    onChange={(e) =>
                      setData({
                        ...data,
                        corporate: {
                          ...data.corporate,
                          incorporationNumber: e.target.value,
                        },
                      })
                    }
                  />
                </div>
              </div>
            )}
          </StepWrapper>
        );

      case "PRICE":
        return (
          <StepWrapper title="Enter the purchase price for the property.">
            <div className="space-y-4 pt-4">
              <label className="block font-bold text-sm text-slate-900">
                Purchase Price
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium">
                  $
                </span>
                <input
                  type="text"
                  placeholder="1,250,000"
                  className="w-full pl-8 pr-4 py-4 border border-slate-300 rounded-lg text-lg outline-none focus:border-brand-primary bg-white text-black font-bold placeholder:text-slate-200"
                  value={data.price}
                  onChange={(e) => setData({ ...data, price: e.target.value })}
                />
              </div>
            </div>
          </StepWrapper>
        );

      case "ADDRESS":
        return (
          <StepWrapper
            title="Enter the address of purchase property?"
            subtitle="(iClosed currently only serves Ontario)"
          >
            <div className="space-y-6 pt-4">
              <div className="space-y-1">
                <label className="block text-xs font-bold text-slate-900">
                  Street Address
                </label>
                <input
                  type="text"
                  placeholder="Start typing your address..."
                  className={inputClasses}
                  value={data.address.street}
                  onChange={(e) =>
                    setData({
                      ...data,
                      address: { ...data.address, street: e.target.value },
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-bold text-slate-900">
                  Unit/Apartment/Suite Number
                </label>
                <input
                  type="text"
                  placeholder="123"
                  className={inputClasses}
                  value={data.address.unit}
                  onChange={(e) =>
                    setData({
                      ...data,
                      address: { ...data.address, unit: e.target.value },
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-bold text-slate-900">
                  City
                </label>
                <input
                  type="text"
                  placeholder="Toronto"
                  className={inputClasses}
                  value={data.address.city}
                  onChange={(e) =>
                    setData({
                      ...data,
                      address: { ...data.address, city: e.target.value },
                    })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="block text-xs font-bold text-slate-900">
                    Postal Code
                  </label>
                  <input
                    type="text"
                    placeholder="A1C 2B3"
                    className={inputClasses}
                    value={data.address.postalCode}
                    onChange={(e) =>
                      setData({
                        ...data,
                        address: {
                          ...data.address,
                          postalCode: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-bold text-slate-900">
                    Province
                  </label>
                  <select className="w-full px-4 py-3 border border-slate-300 rounded-lg text-sm outline-none bg-slate-50 text-slate-600 font-medium cursor-not-allowed">
                    <option>Ontario</option>
                  </select>
                </div>
              </div>
            </div>
          </StepWrapper>
        );

      case "APS":
        return (
          <StepWrapper
            title="Have you signed the Agreement of Purchase and Sale?"
            subtitle="Not sure? It's the legal document that outlines the terms of your deal."
          >
            <div className="space-y-4 pt-4">
              <div
                onClick={() => setData({ ...data, apsSigned: "yes" })}
                className={`p-6 border rounded-xl flex items-center justify-between cursor-pointer transition-all ${data.apsSigned === "yes" ? "border-brand-primary shadow-sm bg-white" : "border-slate-100 bg-white"}`}
              >
                <div>
                  <h4 className="font-bold text-slate-900">Yes</h4>
                  <p className="text-xs text-slate-400">
                    I&apos;ve signed the agreement.
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 ${data.apsSigned === "yes" ? "bg-brand-primary border-brand-primary" : "border-slate-300"}`}
                ></div>
              </div>
              <div
                onClick={() => setData({ ...data, apsSigned: "no" })}
                className={`p-6 border rounded-xl flex items-center justify-between cursor-pointer transition-all ${data.apsSigned === "no" ? "border-brand-primary shadow-sm bg-white" : "border-slate-100 bg-white"}`}
              >
                <div>
                  <h4 className="font-bold text-slate-900">No</h4>
                  <p className="text-xs text-slate-400">
                    I haven&apos;t signed it yet.
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 ${data.apsSigned === "no" ? "bg-brand-primary border-brand-primary" : "border-slate-300"}`}
                ></div>
              </div>
            </div>
          </StepWrapper>
        );

      case "CONTACT":
        return (
          <StepWrapper
            title="Please provide contact details for this transaction"
            subtitle="We'll use these details to send updates and guide you through the process."
          >
            <div className="space-y-6 pt-2">
              <div className="space-y-1">
                <label className="block text-[10px] font-black text-slate-900 uppercase tracking-wider flex items-center gap-1">
                  <span className="text-brand-primary">•</span> Full Name
                </label>
                <input
                  type="text"
                  placeholder="John Doe"
                  className={inputClasses}
                  value={data.contact.fullName}
                  onChange={(e) =>
                    setData({
                      ...data,
                      contact: { ...data.contact, fullName: e.target.value },
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <label className="block text-[10px] font-black text-slate-900 uppercase tracking-wider flex items-center gap-1">
                  <span className="text-brand-primary">•</span> Email Address
                </label>
                <input
                  type="email"
                  placeholder="john@doe.com"
                  className={inputClasses}
                  value={data.contact.email}
                  onChange={(e) =>
                    setData({
                      ...data,
                      contact: { ...data.contact, email: e.target.value },
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <label className="block text-[10px] font-black text-slate-900 uppercase tracking-wider flex items-center gap-1">
                  <span className="text-brand-primary">•</span> Phone Number
                </label>
                <input
                  type="tel"
                  placeholder="(555)-123-4567"
                  className={inputClasses}
                  value={data.contact.phone}
                  onChange={(e) =>
                    setData({
                      ...data,
                      contact: { ...data.contact, phone: e.target.value },
                    })
                  }
                />
              </div>

              <div className="pt-4">
                <button className="w-full border-2 border-dashed border-slate-200 py-3 rounded-lg text-xs font-bold text-slate-400 flex items-center justify-center gap-2 hover:bg-slate-50 transition-colors">
                  <Plus size={14} /> Add Co-Purchaser
                </button>
              </div>
            </div>
          </StepWrapper>
        );

      case "TASKS":
        return (
          <StepWrapper
            title="Upload corporate files"
            subtitle="Please upload your legal corporate documentation. (PDF format only)"
          >
            <div className="space-y-8 pt-4">
              <div className="bg-slate-50 border border-slate-100 rounded-xl p-6">
                <h4 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
                  <Info size={16} className="text-brand-primary" />
                  Documentation Requirements
                </h4>
                <ul className="space-y-2">
                  {[
                    "Files must be clear and legible",
                    "Only PDF files are accepted",
                    "Each file size must not exceed 10MB",
                    "Ensure all pages of the document are included",
                  ].map((text, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 text-xs text-slate-600"
                    >
                      <div className="w-1 h-1 rounded-full bg-slate-900 mt-1.5 shrink-0" />
                      {text}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                    Required Documents
                  </h3>
                  <button
                    onClick={addDocField}
                    className="flex items-center gap-2 text-brand-primary font-bold text-xs hover:underline"
                  >
                    <Plus size={14} /> Add new corporate file
                  </button>
                </div>

                {data.corporateDocs.length === 0 ? (
                  <div className="text-center py-10 border-2 border-dashed border-slate-100 rounded-xl">
                    <p className="text-xs text-slate-400 font-medium">
                      No documents added yet. Click above to add required files.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {data.corporateDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="p-6 border border-slate-200 rounded-xl bg-white shadow-sm animate-in slide-in-from-top-2"
                      >
                        <div className="flex justify-between items-start gap-4 mb-4">
                          <div className="flex-1 space-y-3">
                            <div>
                              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">
                                File Type
                              </label>
                              <div className="relative">
                                <select
                                  className="w-full pl-4 pr-10 py-2.5 border border-slate-200 rounded-lg text-sm font-bold text-slate-800 appearance-none bg-white focus:border-brand-primary outline-none"
                                  value={doc.type}
                                  onChange={(e) =>
                                    updateDoc(doc.id, {
                                      type: e.target.value as any,
                                    })
                                  }
                                >
                                  <option>Article of Incorporation</option>
                                  <option>Corporation Profile</option>
                                  <option>Special Shareholder Agreement</option>
                                  <option>Directors Resolution</option>
                                  <option>Other</option>
                                </select>
                                <ChevronDown
                                  size={14}
                                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                                />
                              </div>
                            </div>
                            {doc.type === "Other" && (
                              <div className="animate-in fade-in slide-in-from-top-2">
                                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">
                                  Specify File Type
                                </label>
                                <input
                                  type="text"
                                  placeholder="e.g. Partnership Agreement"
                                  className="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm font-bold text-slate-800 focus:border-brand-primary outline-none"
                                  value={doc.customType || ""}
                                  onChange={(e) =>
                                    updateDoc(doc.id, {
                                      customType: e.target.value,
                                    })
                                  }
                                />
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => removeDocField(doc.id)}
                            className="p-1.5 text-slate-300 hover:text-red-500 transition-colors mt-6"
                          >
                            <X size={18} />
                          </button>
                        </div>

                        <div className="relative group">
                          <input
                            type="file"
                            accept=".pdf"
                            className="absolute inset-0 opacity-0 cursor-pointer z-10"
                            onChange={(e) => {
                              const file = e.target.files?.[0] || null;
                              if (file && file.type === "application/pdf") {
                                updateDoc(doc.id, { file });
                              } else if (file) {
                                alert("Please upload PDF files only.");
                              }
                            }}
                          />
                          <div
                            className={`p-8 border-2 border-dashed rounded-xl flex flex-col items-center justify-center transition-all ${
                              doc.file
                                ? "bg-green-50 border-green-200"
                                : "bg-slate-50 border-slate-100 group-hover:border-brand-primary group-hover:bg-brand-light/10"
                            }`}
                          >
                            {doc.file ? (
                              <>
                                <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center text-green-600 mb-3">
                                  <Check size={24} />
                                </div>
                                <p className="text-sm font-bold text-slate-900">
                                  {doc.file.name}
                                </p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase mt-1">
                                  Ready to upload
                                </p>
                              </>
                            ) : (
                              <>
                                <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center text-slate-400 mb-3 border border-slate-100">
                                  <FileUp size={24} />
                                </div>
                                <p className="text-sm font-bold text-slate-900">
                                  Click to upload or drag and drop
                                </p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase mt-1">
                                  PDF up to 10MB
                                </p>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </StepWrapper>
        );

      case "SCHEDULE":
        return (
          <StepWrapper nextLabel="Complete">
            <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col md:flex-row h-auto md:h-[400px]">
              <div className="w-full md:w-[300px] border-b md:border-b-0 md:border-r border-slate-100 p-8 flex flex-col bg-slate-50">
                <p className="text-xs font-bold text-slate-400 mb-1">
                  Nava Wilson
                </p>
                <h3 className="text-2xl font-bold text-[#1a3a5f] mb-6">
                  iClosed Lead Meeting
                </h3>
                <div className="space-y-4">
                  <div className="flex items-center gap-3 text-slate-600">
                    <Clock size={18} />
                    <span className="text-sm font-bold">15 min</span>
                  </div>
                  <div className="flex items-start gap-3 text-slate-600">
                    <User size={18} className="mt-1 shrink-0" />
                    <span className="text-sm">
                      Web conferencing details provided upon confirmation.
                    </span>
                  </div>
                </div>
                <p className="mt-8 text-sm text-slate-500">
                  Meeting for iClosed
                </p>
                <div className="mt-auto pt-4 md:pt-0">
                  <button className="text-blue-600 text-xs font-medium hover:underline">
                    Cookie settings
                  </button>
                </div>
              </div>

              <div className="flex-1 p-8 flex flex-col bg-white">
                <div className="flex justify-between items-center mb-6">
                  <h4 className="text-xl font-bold text-slate-800">
                    Select a Date &amp; Time
                  </h4>
                  <div className="flex items-center gap-4">
                    <ChevronLeft
                      size={20}
                      className="text-slate-400 cursor-pointer"
                    />
                    <span className="text-sm font-bold text-slate-600">
                      February 2026
                    </span>
                    <ArrowRight
                      size={20}
                      className="text-blue-500 cursor-pointer"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-7 gap-y-2 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">
                  <div>Sun</div>
                  <div>Mon</div>
                  <div>Tue</div>
                  <div>Wed</div>
                  <div>Thu</div>
                  <div>Fri</div>
                  <div>Sat</div>
                </div>

                <div className="grid grid-cols-7 gap-y-1 gap-x-1 text-center">
                  {Array.from({ length: 28 }).map((_, i) => {
                    const day = i + 1;
                    const isSelectable = [
                      16, 17, 18, 19, 20, 23, 24, 25, 26, 27,
                    ].includes(day);
                    const isToday = day === 12;
                    return (
                      <div
                        key={i}
                        className={`h-10 w-10 flex flex-col items-center justify-center rounded-full mx-auto relative transition-all text-sm font-bold ${
                          isSelectable
                            ? "bg-blue-50 text-blue-600 cursor-pointer hover:bg-blue-600 hover:text-white"
                            : "text-slate-300 pointer-events-none"
                        }`}
                      >
                        {day}
                        {isToday && (
                          <div className="absolute bottom-1 w-1 h-1 bg-blue-600 rounded-full"></div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-auto pt-8 flex items-center gap-2 text-xs text-slate-600">
                  <div className="w-4 h-4 rounded-full bg-slate-100 flex items-center justify-center text-[8px] font-black text-slate-400">
                    ?
                  </div>
                  <span className="font-bold">
                    Eastern Time - US &amp; Canada (10:11am)
                  </span>
                </div>
              </div>
            </div>
          </StepWrapper>
        );

      case "SUCCESS":
        return (
          <div className="max-w-4xl mx-auto h-[600px] flex flex-col items-center justify-center space-y-4 bg-white rounded-xl border border-rose-100 animate-in fade-in zoom-in duration-500">
            <div className="bg-green-100 p-8 rounded-full">
              <CheckCircle2 size={80} className="text-green-600" />
            </div>
            <h2 className="text-4xl font-bold text-slate-900 tracking-tight">
              Intake Successful
            </h2>
            <p className="text-slate-500 text-lg">
              The file has been initialized and assigned to your dashboard.
            </p>
            <button
              onClick={() => {
                setCurrentStep("SERVICE");
                setData({
                  service: null,
                  subService: null,
                  clientType: null,
                  price: "",
                  address: {
                    street: "",
                    unit: "",
                    city: "",
                    postalCode: "",
                    province: "Ontario",
                  },
                  apsSigned: null,
                  contact: { fullName: "", email: "", phone: "" },
                  corporate: {
                    name: "",
                    incorporationNumber: "",
                    jurisdiction: "",
                    email: "",
                  },
                  corporateDocs: [],
                });
              }}
              className="mt-10 px-8 py-3 bg-brand-primary text-white font-bold rounded-xl shadow-lg hover:bg-brand-primaryHover transition-all active:scale-95"
            >
              Start another intake
            </button>
          </div>
        );

      default:
        return <div>Unknown Step</div>;
    }
  };

  return (
    <div className="min-h-full py-8 px-4">
      {renderStep()}
      <div className="mt-12 text-center">
        <p className="text-[10px] text-slate-300 font-bold uppercase tracking-widest">
          iClosed ©2025
        </p>
      </div>
    </div>
  );
};

export default Intake;
