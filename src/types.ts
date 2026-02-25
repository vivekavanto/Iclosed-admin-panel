export enum DealType {
  PURCHASE = 'Purchase',
  SALE = 'Sale',
  REFINANCE = 'Refinance'
}

export enum DealStatus {
  ACTIVE = 'Active',
  PENDING = 'Pending',
  CLOSED = 'Closed',
  CANCELLED = 'Cancelled',
  URGENT = 'Urgent'
}

export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  dueDate?: string;
  assignee?: string;
  status?: 'Pending' | 'In Progress' | 'Completed';
  completedAt?: string;
  document?: { name: string; url: string };
}

export interface Milestone {
  id: string;
  title: string;
  status: '' | 'Pending' | 'In Progress' | 'Completed';
  milestoneDate?: string;
  completedAt?: string;
  emailSent?: boolean;
}

export interface DealDocument { id: string; name: string; type: string; uploadDate: string; status: 'Draft' | 'Review' | 'Signed' | 'Registered'; }

export interface Deal {
  id: string;
  fileNumber: string;
  client: Client;
  type: DealType;
  status: DealStatus;
  propertyAddress: string;
  closingDate: string;
  openingDate?: string;
  requisitionDate?: string;
  price: number;
  progress: number;
  tasks: Task[];
  milestones?: Milestone[];
  documents: DealDocument[];
  notes: string[];
}

export interface User { id: string; name: string; role: 'Admin' | 'Clerk' | 'Lawyer'; avatarUrl?: string; }
