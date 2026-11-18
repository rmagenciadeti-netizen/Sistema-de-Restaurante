import { z } from 'zod';
import { appearancePreferenceSchema } from './settings';

export type AppearancePreference = z.infer<typeof appearancePreferenceSchema>;
export const DEFAULT_APPEARANCE: AppearancePreference = { mode: 'DARK', primary: 'GOLD', sidebar: 'BLACK' };

// Priority: personal preference (when the restaurant allows it) > restaurant default > RM default.
export function resolveAppearance(tenant: (AppearancePreference & { allowUserOverride: boolean }) | null, user: unknown): { source: 'USER' | 'TENANT' | 'DEFAULT'; value: AppearancePreference } {
  const personal = appearancePreferenceSchema.safeParse(user);
  if (personal.success && (tenant?.allowUserOverride ?? true)) return { source: 'USER', value: personal.data };
  if (tenant) return { source: 'TENANT', value: { mode: tenant.mode, primary: tenant.primary, sidebar: tenant.sidebar } };
  return { source: 'DEFAULT', value: DEFAULT_APPEARANCE };
}
