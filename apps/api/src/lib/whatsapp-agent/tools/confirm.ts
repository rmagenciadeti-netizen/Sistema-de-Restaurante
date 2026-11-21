import { createHash, randomBytes } from 'node:crypto';
import { normalizeText } from '../../whatsapp-text';
import { PENDING_TTL_MS, type PendingAction } from '../memory';
import type { ToolContext, ToolOutput } from '../types';
import { fail, ok } from './common';

// Two-step protocol for what cannot be undone (placing/changing/cancelling an order, cancelling a reservation). The first call only PROPOSES: it stores the exact
// snapshot and returns the summary the customer must see. The operation runs only on a later call, made after a LATER customer message, for the SAME snapshot,
// and quoting the customer's own words that confirm it. The model can therefore never skip the customer's yes, nor confirm something that changed since.
export function requireConfirmation(ctx: ToolContext, a: { action: PendingAction['action']; targetId?: string; snapshot: unknown; summary: string; confirmation?: string }): { proceed: true } | { proceed: false; output: ToolOutput } {
  const hash = createHash('sha256').update(JSON.stringify(a.snapshot)).digest('hex').slice(0, 20);
  const matches = (item: PendingAction) => item.action === a.action && item.targetId === a.targetId;
  const existing = ctx.memory.pending.find(matches);
  const fresh = existing && existing.hash === hash && Date.parse(existing.expiresAt) > ctx.now.getTime();
  const ask = (note: string): { proceed: false; output: ToolOutput } => ({ proceed: false, output: ok({ status: 'NEEDS_CUSTOMER_CONFIRMATION', whatTheCustomerMustSee: a.summary, instruction: note }, 'Aguardando a confirmação do cliente', { proposal: true }) });
  if (!fresh) {
    ctx.memory.pending = [...ctx.memory.pending.filter(item => !matches(item)), { id: randomBytes(4).toString('hex'), action: a.action, targetId: a.targetId, hash, summary: a.summary.slice(0, 700), proposedAtMessageId: ctx.messageId, expiresAt: new Date(ctx.now.getTime() + PENDING_TTL_MS).toISOString() }].slice(-4);
    return ask('Mostre este resumo ao cliente (com valores reais) e pergunte se ele confirma. NÃO execute agora: espere a resposta dele e então chame a mesma ferramenta de novo, passando em "confirmation" as palavras dele.');
  }
  if (existing.proposedAtMessageId === ctx.messageId) return ask('O resumo foi proposto agora, nesta mesma mensagem do cliente. Apresente-o ao cliente e espere a resposta dele antes de confirmar.');
  const quote = normalizeText(a.confirmation ?? '');
  if (quote.length < 2 || !normalizeText(ctx.inboundText).includes(quote)) return { proceed: false, output: fail('CONFIRMATION_MISSING', 'Para executar, passe em "confirmation" as palavras exatas da ÚLTIMA mensagem do cliente que confirmam (ex.: "sim", "pode confirmar"). Se ele não confirmou claramente, pergunte de novo.') };
  return { proceed: true };
}

export const consumePending = (ctx: ToolContext, action: PendingAction['action'], targetId?: string) => { ctx.memory.pending = ctx.memory.pending.filter(item => !(item.action === action && item.targetId === targetId)); };
