export enum DealType {
  PURCHASE = 'Purchase',
  SALE = 'Sale',
  REFINANCE = 'Refinance',
  PURCHASE_AND_SALE = 'Purchase & Sale'
}

export enum DealStatus {
  ACTIVE = 'Active',
  CLOSED = 'Closed',
  CANCELLED = 'Cancelled',
  URGENT = 'Urgent',
  INACTIVE = 'Inactive',
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
  clientId?: string;
  milestoneId?: string;
  isShared?: boolean;
  taskTemplateId?: string | null;
  leadType?: string | null;
  orderIndex?: number | null;
}

export interface Milestone {
  id: string;
  title: string;
  status: '' | 'Pending' | 'In Progress' | 'Completed';
  milestoneDate?: string;
  completedAt?: string;
  emailSent?: boolean;
  emailTemplateId?: string | null;
  stageTemplateId?: string | null;
  leadType?: string | null;
  orderIndex?: number | null;
}

export interface DealDocument { id: string; name: string; type: string; uploadDate: string; status: 'Draft' | 'Review' | 'Signed' | 'Registered'; }

export interface Deal {
  id: string;
  fileNumber: string;
  client: Client;
  type: DealType;
  status: DealStatus;
  propertyAddress: string;
  sellingPropertyAddress?: string;
  closingDate: string;
  openingDate?: string;
  requisitionDate?: string;
  price: number;
  progress: number;
  tasks: Task[];
  milestones?: Milestone[];
  documents: DealDocument[];
  notes: string[];
  completedTasks?: number;
  totalTasks?: number;
}

export interface User { id: string; name: string; role: 'Admin' | 'Clerk' | 'Lawyer'; avatarUrl?: string; }
