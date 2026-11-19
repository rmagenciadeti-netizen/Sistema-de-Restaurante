import { randomBytes } from 'node:crypto';
import type { TefAdapter, TefResponse } from './adapter';
import { TefTimeoutError } from './adapter';

// Development/test simulator. It exists to exercise the TEF state machine (approval, denial, timeout, pending, reversal) without a provider or a PinPad.
// It is refused in production, its transactions are flagged `simulated` and never feed the fiscal document.
type Remote = { response: TefResponse; reversed: boolean; pending?: { amount: string; method: string }; waiting?: boolean };

export function createMockAdapter(): TefAdapter & { remote: Map<string, Remote> } {
  const remote = new Map<string, Remote>();
  const approved = (reference: string, amount: string, brand = 'VISA'): TefResponse => ({
    outcome: 'APPROVED', providerRef: `SIM-${reference.slice(0, 8)}`, amount, nsu: randomBytes(4).toString('hex').toUpperCase(), authorizationCode: randomBytes(3).toString('hex').toUpperCase(), cardBrand: brand, acquirerCnpj: '00000000000191', responseCode: '00', message: 'Aprovada (simulada)',
  });
  return {
    name: 'mock', label: 'Simulador de desenvolvimento (não é um provedor real)', simulated: true, remote,
    fields: [{ key: 'scenario', label: 'Cenário padrão', options: ['approve', 'deny', 'timeout', 'pending', 'waiting'], hint: 'Somente para testes internos.' }],
    capabilities: { methods: ['CREDIT_CARD', 'DEBIT_CARD', 'PIX', 'VOUCHER'], installments: true, query: true, cancel: true, pix: true },
    async testConnection() { return { ok: true, message: 'Simulador ativo (nenhuma comunicação real).' }; },
    async start(request, config) {
      const existing = remote.get(request.reference);
      if (existing) return existing.response;
      const scenario = request.hints?.scenario ?? String(config.connection.scenario ?? 'approve');
      if (scenario === 'deny') { const response: TefResponse = { outcome: 'DENIED', responseCode: '51', message: 'Negada (simulada)' }; remote.set(request.reference, { response, reversed: false }); return response; }
      if (scenario === 'waiting') { remote.set(request.reference, { response: { outcome: 'PENDING', message: 'Aguardando o cliente' }, reversed: false, waiting: true }); return { outcome: 'PENDING', message: 'Aguardando o cliente' }; }
      if (scenario === 'pending') { remote.set(request.reference, { response: { outcome: 'PENDING', message: 'Aguardando o cliente' }, reversed: false, pending: { amount: request.amount, method: request.method } }); return { outcome: 'PENDING', message: 'Aguardando o cliente' }; }
      const response = approved(request.reference, request.amount, request.method === 'PIX' ? 'PIX' : 'VISA');
      if (request.method === 'PIX') response.pixEndToEnd = `E00000000${Date.now()}${randomBytes(6).toString('hex')}`.slice(0, 32);
      remote.set(request.reference, { response, reversed: false });
      // The provider processed it but the answer never reached us.
      if (scenario === 'timeout') throw new TefTimeoutError('Sem resposta do provedor (simulado)');
      return response;
    },
    async query(reference) {
      const entry = remote.get(reference);
      if (!entry) return { outcome: 'NOT_FOUND', message: 'O provedor não tem registro desta transação' };
      if (entry.reversed) return { ...entry.response, outcome: 'REVERSED' };
      // The customer finished at the PinPad after the first poll.
      if (entry.pending) { entry.response = approved(reference, entry.pending.amount, entry.pending.method === 'PIX' ? 'PIX' : 'VISA'); entry.pending = undefined; }
      return entry.response;
    },
    async cancel(transaction) {
      const entry = remote.get(transaction.reference);
      if (entry && (entry.pending || entry.waiting)) { entry.pending = undefined; entry.waiting = false; entry.response = { outcome: 'CANCELLED', message: 'Desfeita (simulada)' }; return { ok: true, reversalRef: `SIM-UNDO-${transaction.reference.slice(0, 8)}` }; }
      if (!entry || entry.response.outcome !== 'APPROVED') return { ok: false, message: 'Transação não aprovada no provedor' };
      entry.reversed = true;
      return { ok: true, reversalRef: `SIM-CANC-${transaction.reference.slice(0, 8)}` };
    },
  };
}
