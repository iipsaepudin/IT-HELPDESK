export type Ticket = {
  id: string;
  createdAt: string;
  updatedAt: string;
  requesterName: string;
  requesterEmail?: string;
  whatsappNumber: string;
  department?: string;
  category: string;
  subcategory: string;
  subject: string;
  description: string;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  impact: 'Minor' | 'Moderate' | 'Major';
  status: 'New' | 'In Progress' | 'Waiting' | 'Resolved' | 'Closed';
  slaFirstResponseHrs: number;
  slaResolutionHrs: number;
  dueFirstResponseAt: string;
  dueResolutionAt: string;
  attachments: { name: string; size?: number; url?: string }[];
  assetTag?: string;
  location?: string;
  tags?: string[];
  assignee?: string;
};

export type Comment = {
  id: string;
  ticketId: string;
  author: string;
  body: string;
  createdAt: string;
}

export type StatsMonthly = {
  month: number; // 1-12
  total: number;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
}

const API_URL = import.meta.env.VITE_API_URL;

async function api(path: string, init?: RequestInit) {
  const base = API_URL || '';
  const token = localStorage.getItem('token');
  const headers: Record<string,string> = {};
  if (!(init?.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...(init?.headers||{}), ...headers } });
  if (!res.ok) throw new Error(await res.text());
  const ct = res.headers.get('content-type')||'';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

export const hasApi = !!API_URL;

// auth
export const login = (email: string, password: string) => api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }) as Promise<{token:string}>;

// tickets
export const listTickets = () => api('/api/tickets') as Promise<Ticket[]>;
export const createTicket = (t: Partial<Ticket>) => api('/api/tickets', { method: 'POST', body: JSON.stringify(t) }) as Promise<Ticket>;
export const patchTicket = (id: string, patch: Partial<Ticket>) => api(`/api/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<Ticket>;
export const listComments = (id: string) => api(`/api/tickets/${id}/comments`) as Promise<Comment[]>;
export const addComment = (id: string, body: string, author='Agent') => api(`/api/tickets/${id}/comments`, { method: 'POST', body: JSON.stringify({ body, author }) }) as Promise<Comment>;
export const uploadAttachment = (id: string, file: File) => { const fd = new FormData(); fd.append('file', file); return api(`/api/tickets/${id}/attachments`, { method: 'POST', body: fd }) as Promise<{name:string,url:string}>; }
export const getStats = (year: number) => api(`/api/stats/monthly?year=${year}`) as Promise<StatsMonthly[]>;
