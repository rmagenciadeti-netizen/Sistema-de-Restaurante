const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('rm_restaurant_token') : null;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.message ?? 'Falha ao comunicar com a API', response.status);
  return payload as T;
}

export type ListResponse<T> = { items: T[]; total: number; page?: number; pageSize?: number };
export type Unit = { id: string; name: string; code?: string | null; address?: string | null; status: string };
export type Employee = { id: string; fullName: string; cpf?: string | null; phone?: string | null; email?: string | null; position?: string | null; status: string; unitId?: string | null };
export type Sector = { id: string; name: string };
export type Product = { id: string; name: string; code?: string | null; price: string | number; cost?: string | number | null; active: boolean; category?: { name: string } | null; sector?: Sector | null; unitId?: string | null };
export type Order = { id: string; code: string; channel: string; status: string; customerName?: string | null; tableLabel?: string | null; total: string | number; createdAt: string; items: { id: string; quantity: number; product: { name: string } }[] };
export type Tenant = { id: string; name: string; slug: string; plan: string; status: string; _count?: { units: number; users: number } };
