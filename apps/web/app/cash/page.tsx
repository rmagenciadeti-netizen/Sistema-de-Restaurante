'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ListResponse, Order, Unit } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass } from '../../components/app-shell';

type OrderWithPayments = Order & {
  unitId: string | null;
  payments: Array<{ amount: string | number }>;
};

type CashSession = {
  id: string;
  unitId: string | null;
  openingAmount: string | number;
  closingAmount?: string | number | null;
  expectedAmount?: string | number | null;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt?: string | null;
  payments: Array<{ amount: string | number; method: string; status: string }>;
};

type Payment = {
  id: string;
  orderId: string | null;
  cashSessionId: string | null;
  method: string;
  amount: string | number;
  status: string;
  paidAt: string;
  order?: { code: string } | null;
};

const paymentMethods = [
  { value: 'CASH', label: 'Dinheiro' },
  { value: 'PIX', label: 'PIX (registro manual)' },
  { value: 'CREDIT_CARD', label: 'Cartão de crédito (registro manual)' },
  { value: 'DEBIT_CARD', label: 'Cartão de débito (registro manual)' },
  { value: 'VOUCHER', label: 'Vale-refeição' },
  { value: 'OTHER', label: 'Outro' },
];

function money(value: number | string) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function paidAmount(order: OrderWithPayments) {
  return order.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
}

export default function CashPage() {
  const [orders, setOrders] = useState<OrderWithPayments[]>([]);
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [openAmount, setOpenAmount] = useState('0.00');
  const [closingAmount, setClosingAmount] = useState('');
  const [openUnitId, setOpenUnitId] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [message, setMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [orderResult, sessionResult, paymentResult, unitResult] = await Promise.all([
        api<ListResponse<OrderWithPayments>>('/orders?pageSize=100'),
        api<ListResponse<CashSession>>('/cash/sessions'),
        api<ListResponse<Payment>>('/cash/payments'),
        api<ListResponse<Unit>>('/units'),
      ]);
      setOrders(orderResult.items);
      setSessions(sessionResult.items);
      setPayments(paymentResult.items);
      setUnits(unitResult.items);
      setSelectedSessionId(current => current || sessionResult.items.find(session => session.status === 'OPEN')?.id || '');
      setOrderId(current => current || orderResult.items.find(order => order.status !== 'CANCELLED' && Number(order.total) > paidAmount(order))?.id || '');
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Erro ao carregar caixa', kind: 'error' });
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function initialLoad() {
      try {
        const [orderResult, sessionResult, paymentResult, unitResult] = await Promise.all([
          api<ListResponse<OrderWithPayments>>('/orders?pageSize=100'),
          api<ListResponse<CashSession>>('/cash/sessions'),
          api<ListResponse<Payment>>('/cash/payments'),
          api<ListResponse<Unit>>('/units'),
        ]);
        if (!active) return;
        setOrders(orderResult.items);
        setSessions(sessionResult.items);
        setPayments(paymentResult.items);
        setUnits(unitResult.items);
        setSelectedSessionId(current => current || sessionResult.items.find(session => session.status === 'OPEN')?.id || '');
        setOrderId(current => current || orderResult.items.find(order => order.status !== 'CANCELLED' && Number(order.total) > paidAmount(order))?.id || '');
      } catch (error) {
        if (active) setMessage({ text: error instanceof Error ? error.message : 'Erro ao carregar caixa', kind: 'error' });
      }
    }
    void initialLoad();
    return () => { active = false; };
  }, []);

  const unpaidOrders = useMemo(() => orders.filter(order => order.status !== 'CANCELLED' && Number(order.total) > paidAmount(order)), [orders]);
  const openSessions = sessions.filter(session => session.status === 'OPEN');
  const selectedOrder = unpaidOrders.find(order => order.id === orderId);
  const remainingBalance = selectedOrder ? Math.max(0, Number(selectedOrder.total) - paidAmount(selectedOrder)) : 0;
  const selectedSession = openSessions.find(session => session.id === selectedSessionId);
  const matchingCashSession = openSessions.find(session => session.unitId === selectedOrder?.unitId);
  const tenantUnassigned = units.some(unit => unit.id === openUnitId);

  async function openSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api('/cash/sessions', {
        method: 'POST',
        body: JSON.stringify({ openingAmount: Number(openAmount), ...(tenantUnassigned && openUnitId ? { unitId: openUnitId } : {}) }),
      });
      setOpenAmount('0.00');
      setMessage({ text: 'Caixa aberto.', kind: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Erro ao abrir caixa', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function closeSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSessionId) return;
    setBusy(true);
    setMessage(null);
    try {
      const closed = await api<CashSession>(`/cash/sessions/${selectedSessionId}/close`, {
        method: 'POST',
        body: JSON.stringify({ closingAmount: Number(closingAmount) }),
      });
      const difference = Number(closed.closingAmount) - Number(closed.expectedAmount);
      setClosingAmount('');
      setMessage({ text: `Caixa fechado. Diferença apurada: ${money(difference)}.`, kind: 'success' });
      setSelectedSessionId('');
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Erro ao fechar caixa', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOrder || Number(paymentAmount) <= 0 || Number(paymentAmount) > remainingBalance) {
      setMessage({ text: 'Informe um valor positivo que não ultrapasse o saldo pendente.', kind: 'error' });
      return;
    }
    if (paymentMethod === 'CASH' && !matchingCashSession) {
      setMessage({ text: 'Abra um caixa para a unidade deste pedido antes de registrar pagamento em dinheiro.', kind: 'error' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api('/cash/payments', {
        method: 'POST',
        body: JSON.stringify({
          orderId: selectedOrder.id,
          method: paymentMethod,
          amount: Number(paymentAmount),
          ...(paymentMethod === 'CASH' && matchingCashSession ? { cashSessionId: matchingCashSession.id } : {}),
        }),
      });
      setMessage({ text: 'Pagamento registrado.', kind: 'success' });
      setPaymentAmount('');
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Erro ao registrar pagamento', kind: 'error' });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return <AppShell title="Caixa e pagamentos">
    {message && <Notice message={message.text} kind={message.kind} />}

    <div className="grid gap-6 xl:grid-cols-2">
      <section className={panelClass}>
        <h2 className="mb-4 text-lg font-semibold">Abrir caixa</h2>
        <form onSubmit={openSession} className="grid gap-4 md:grid-cols-2">
          <Field label="Valor inicial (R$)" type="number" min="0" max="9999999999.99" step="0.01" required value={openAmount} onChange={event => setOpenAmount(event.target.value)} />
          {units.length > 0 && <label className="text-sm text-slate-300">Unidade (administrador sem unidade vinculada)<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={openUnitId} onChange={event => setOpenUnitId(event.target.value)}><option value="">Unidade padrão da conta</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>}
          <div className="flex items-end"><button className={buttonClass} disabled={busy}>Abrir caixa</button></div>
        </form>
      </section>

      <section className={panelClass}>
        <h2 className="mb-4 text-lg font-semibold">Fechar caixa</h2>
        {openSessions.length === 0 ? <p className="text-sm text-slate-400">Não há caixa aberto no escopo da sua conta.</p> : <form onSubmit={closeSession} className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-slate-300">Caixa<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" required value={selectedSessionId} onChange={event => setSelectedSessionId(event.target.value)}>{openSessions.map(session => <option key={session.id} value={session.id}>{session.unitId ? units.find(unit => unit.id === session.unitId)?.name ?? 'Unidade' : 'Sem unidade'} · abertura {new Date(session.openedAt).toLocaleString('pt-BR')}</option>)}</select></label>
          <Field label="Valor contado (R$)" type="number" min="0" max="9999999999.99" step="0.01" required value={closingAmount} onChange={event => setClosingAmount(event.target.value)} />
          <div className="text-sm text-slate-400 md:col-span-2">Saldo esperado: {selectedSession ? money(Number(selectedSession.openingAmount) + selectedSession.payments.filter(payment => payment.status === 'CONFIRMED' && payment.method === 'CASH').reduce((sum, payment) => sum + Number(payment.amount), 0)) : '—'}</div>
          <div className="flex items-end"><button className={`${buttonClass} bg-red-700 hover:bg-red-600`} disabled={busy}>Fechar caixa</button></div>
        </form>}
      </section>

      <section className={`${panelClass} xl:col-span-2`}>
        <h2 className="mb-4 text-lg font-semibold">Receber pagamento</h2>
        <form onSubmit={recordPayment} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm text-slate-300 xl:col-span-2">Pedido com saldo pendente<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" required value={orderId} onChange={event => { setOrderId(event.target.value); setPaymentAmount(''); }}><option value="">Selecione</option>{unpaidOrders.map(order => <option key={order.id} value={order.id}>{order.code} · {order.items.map(item => `${item.quantity}× ${item.product.name}`).join(', ')} · pendente {money(Number(order.total) - paidAmount(order))}</option>)}</select></label>
          <label className="text-sm text-slate-300">Forma de pagamento<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}>{paymentMethods.map(method => <option key={method.value} value={method.value}>{method.label}</option>)}</select></label>
          <Field label="Valor recebido (R$)" type="number" min="0.01" max={remainingBalance.toFixed(2)} step="0.01" required value={paymentAmount} onChange={event => setPaymentAmount(event.target.value)} />
          {selectedOrder && <p className="text-sm text-slate-400 md:col-span-2 xl:col-span-3">Total: {money(selectedOrder.total)} · pago: {money(paidAmount(selectedOrder))} · saldo: {money(remainingBalance)}{paymentMethod === 'CASH' ? (matchingCashSession ? ' · será vinculado ao caixa aberto da unidade' : ' · nenhum caixa compatível está aberto') : ''}</p>}
          <div className="flex items-end"><button className={buttonClass} disabled={busy || !selectedOrder || (paymentMethod === 'CASH' && !matchingCashSession)}>{busy ? 'Processando...' : 'Registrar pagamento'}</button></div>
          <p className="text-xs text-slate-500 md:col-span-2 xl:col-span-4">PIX e cartões são apenas registros manuais; nenhuma cobrança ou confirmação é enviada a provedores externos.</p>
        </form>
      </section>

      <section className={`${panelClass} xl:col-span-2`}>
        <h2 className="mb-4 text-lg font-semibold">Pedidos recentes e saldos ({orders.length})</h2>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Pedido</th><th className="p-3">Estado</th><th className="p-3">Total</th><th className="p-3">Pago</th><th className="p-3">Pendente</th></tr></thead><tbody>{orders.map(order => <tr key={order.id} className="border-t border-slate-800"><td className="p-3">{order.code}</td><td className="p-3">{order.status}</td><td className="p-3">{money(order.total)}</td><td className="p-3">{money(paidAmount(order))}</td><td className="p-3">{money(Math.max(0, Number(order.total) - paidAmount(order)))}</td></tr>)}</tbody></table>{orders.length === 0 && <p className="p-4 text-slate-400">Nenhum pedido encontrado.</p>}</div>
      </section>

      <section className={`${panelClass} xl:col-span-2`}>
        <h2 className="mb-4 text-lg font-semibold">Pagamentos recentes ({payments.length})</h2>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Data</th><th className="p-3">Pedido</th><th className="p-3">Forma</th><th className="p-3">Valor</th><th className="p-3">Estado</th></tr></thead><tbody>{payments.map(payment => <tr key={payment.id} className="border-t border-slate-800"><td className="p-3">{new Date(payment.paidAt).toLocaleString('pt-BR')}</td><td className="p-3">{payment.order?.code ?? '—'}</td><td className="p-3">{paymentMethods.find(method => method.value === payment.method)?.label ?? payment.method}</td><td className="p-3">{money(payment.amount)}</td><td className="p-3">{payment.status}</td></tr>)}</tbody></table>{payments.length === 0 && <p className="p-4 text-slate-400">Nenhum pagamento registrado.</p>}</div>
      </section>
    </div>
  </AppShell>;
}
