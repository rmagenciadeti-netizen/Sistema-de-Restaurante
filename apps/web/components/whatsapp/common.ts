import { ApiError, errorMessage } from '../../lib/api';
import { saveErrorMessage } from '../../lib/settings-helpers';

export type Flash = { text: string; kind: 'error' | 'success' } | null;

export const forbiddenText = 'Seu perfil não tem permissão para esta ação.';

export function friendlyError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 403) return forbiddenText;
  return error instanceof ApiError ? saveErrorMessage(error, fallback) : errorMessage(error, fallback);
}

export function displayPhone(phone: string | null | undefined): string {
  if (!phone) return 'Sem número';
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return phone;
}

export function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export const sourceLabel: Record<string, string> = { CUSTOMER: 'Cliente', BOT: 'Robô', STAFF: 'Atendente', AUTO: 'Automática' };
