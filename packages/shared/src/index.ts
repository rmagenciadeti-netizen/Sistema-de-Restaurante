export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'TRIAL' | 'BLOCKED';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
}

export const appName = 'RM Restaurant SaaS';
