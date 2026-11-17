'use client';

import { useState } from 'react';
import { api, errorMessage, storedUser } from './api';
import { MANAGEMENT_ROLES, saveErrorMessage } from './settings-helpers';
import type { SettingsResponse, SettingsSectionName, TenantSettings } from './settings';
import { useAutoLoad } from './use-auto-load';

export type Notice = { text: string; kind: 'error' | 'success' };

// Loads GET /settings once and keeps a editable draft; sections are saved one at a time with PUT /settings/:section.
export function useSettings() {
  const [saved, setSaved] = useState<TenantSettings | null>(null);
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [hasAdminPassword, setHasAdminPassword] = useState(false);
  const [role, setRole] = useState<string | undefined>();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);

  async function reload() {
    try {
      const result = await api<SettingsResponse>('/settings');
      setSaved(result.settings); setDraft(result.settings); setHasAdminPassword(result.hasAdminPassword); setRole(storedUser().role);
    } catch (e) { setNotice({ text: errorMessage(e, 'Erro ao carregar as configurações'), kind: 'error' }); }
  }
  useAutoLoad(reload);

  const canEdit = MANAGEMENT_ROLES.includes(role ?? '');
  const isDirty = (section: SettingsSectionName) => Boolean(saved && draft && JSON.stringify(saved[section]) !== JSON.stringify(draft[section]));
  function patch<S extends SettingsSectionName>(section: S, change: Partial<TenantSettings[S]>) {
    setDraft(current => (current ? { ...current, [section]: { ...current[section], ...change } } : current));
  }
  async function save<S extends SettingsSectionName>(section: S, successText: string) {
    if (!draft) return false;
    setSaving(true); setNotice(null);
    try {
      const result = await api<{ section: S; value: TenantSettings[S] }>(`/settings/${section}`, { method: 'PUT', body: JSON.stringify(draft[section]) });
      setSaved(current => (current ? { ...current, [section]: result.value } : current));
      setDraft(current => (current ? { ...current, [section]: result.value } : current));
      setNotice({ text: successText, kind: 'success' });
      return true;
    } catch (e) { setNotice({ text: saveErrorMessage(e, 'Erro ao salvar'), kind: 'error' }); return false; } finally { setSaving(false); }
  }
  return { draft, saved, hasAdminPassword, setHasAdminPassword, role, canEdit, notice, setNotice, saving, isDirty, patch, save, reload };
}
