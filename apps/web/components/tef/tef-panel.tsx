'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { buttonClass, Check, Field, Notice, panelClass, Select, secondaryButtonClass } from '../app-shell';
import { Badge, DataTable, EmptyState, StatCard, Tabs } from '../ui';
import { INTEGRATION_STATUS, METHOD_LABEL, TEF_STATUS, type TefMonitor, type TefProvider, type TefReconciliation, type TefTransaction } from '../../lib/types-tef';

const sections = [{ key: 'providers', label: 'Provedores' }, { key: 'monitor', label: 'Monitoramento' }, { key: 'reconciliation', label: 'Conciliação' }, { key: 'events', label: 'Eventos' }] as const;
type Section = (typeof sections)[number]['key'];
const monthStart = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

type Draft = { environment: string; establishmentCnpj: string; merchantCode: string; logicalNumber: string; terminalId: string; cashRegisterId: string; pinpad: string; connection: Record<string, string>; credentials: Record<string, string>; enabledMethods: string[];
  printing: { autoPrint: boolean; copies: number; paper: string; allowReprint: boolean }; homologationEvidence: string; acceptedBrands: string; financialMapping: Record<string, string> };

function draftOf(provider: TefProvider): Draft {
  return {
    environment: provider.environment, establishmentCnpj: provider.establishmentCnpj, merchantCode: provider.merchantCode, logicalNumber: provider.logicalNumber, terminalId: provider.terminalId, cashRegisterId: provider.cashRegisterId, pinpad: provider.pinpad,
    connection: Object.fromEntries(Object.entries(provider.connection).map(([key, value]) => [key, String(value)])), credentials: {}, enabledMethods: provider.enabledMethods,
    printing: { autoPrint: Boolean(provider.printing.autoPrint), copies: provider.printing.copies ?? 1, paper: provider.printing.paper ?? '80mm', allowReprint: provider.printing.allowReprint ?? true }, homologationEvidence: provider.homologationEvidence, acceptedBrands: provider.acceptedBrands.join(', '), financialMapping: Object.fromEntries(Object.entries(provider.financialMapping ?? {}).map(([key, value]) => [key, String(value)])),
  };
}

function ProviderCard({ provider, onChanged, say }: { provider: TefProvider; onChanged: () => Promise<void>; say: (text: string, kind: 'error' | 'success') => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(provider)); const [busy, setBusy] = useState(false);
  const status = INTEGRATION_STATUS[provider.integrationStatus];
  const set = (patch: Partial<Draft>) => setDraft(current => ({ ...current, ...patch }));
  const body = (extra: Record<string, unknown> = {}) => ({
    environment: draft.environment, establishmentCnpj: draft.establishmentCnpj, merchantCode: draft.merchantCode, logicalNumber: draft.logicalNumber, terminalId: draft.terminalId, cashRegisterId: draft.cashRegisterId, pinpad: draft.pinpad,
    connection: draft.connection, credentials: Object.fromEntries(Object.entries(draft.credentials).filter(([, value]) => value.trim() !== '')), enabledMethods: draft.enabledMethods, printing: draft.printing,
    acceptedBrands: draft.acceptedBrands.split(',').map(item => item.trim()).filter(Boolean), homologationEvidence: draft.homologationEvidence, financialMapping: Object.fromEntries(Object.entries(draft.financialMapping).filter(([, value]) => value.trim() !== '')), ...extra,
  });
  async function run(action: () => Promise<string>) {
    setBusy(true);
    try { say(await action(), 'success'); await onChanged(); setDraft(current => ({ ...current, credentials: {} })); } catch (cause) { say(errorMessage(cause, 'Falha na operação'), 'error'); } finally { setBusy(false); }
  }
  const save = (extra?: Record<string, unknown>) => run(async () => { await api(`/tef/config/${provider.provider}`, { method: 'PUT', body: JSON.stringify(body(extra)) }); return 'Configuração salva. As credenciais ficam protegidas e não são exibidas novamente.'; });
  const test = () => run(async () => { const result = await api<{ ok: boolean; message: string }>(`/tef/config/${provider.provider}/test`, { method: 'POST' }); if (!result.ok) throw new Error(result.message); return `Comunicação OK: ${result.message}`; });
  const plain = provider.fields.filter(field => !field.secret); const secret = provider.fields.filter(field => field.secret);
  return <article className={`${panelClass} space-y-4`}>
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-lg font-semibold">{provider.label}</h3><p className="text-xs text-slate-500">Identificador: <code>{provider.provider}</code> · Formas: {provider.capabilities.methods.map(method => METHOD_LABEL[method] ?? method).join(', ')}{provider.capabilities.cancel ? ' · Cancelamento' : ''}{provider.capabilities.query ? ' · Consulta' : ''}</p></div>
      <div className="flex gap-2">{provider.simulated && <Badge tone="amber">Simulador — não é real</Badge>}<Badge tone={status.tone}>{status.label}</Badge></div>
    </header>
    {provider.lastTest && <p className="text-xs text-slate-600">Último teste de comunicação: {formatDateTime(provider.lastTest.at)} — {provider.lastTest.ok ? 'sucesso' : 'falha'}{provider.lastTest.message ? ` (${provider.lastTest.message})` : ''}</p>}
    <div className="grid gap-4 md:grid-cols-3">
      <Select label="Ambiente" value={draft.environment} onChange={event => set({ environment: event.target.value })}><option value="HOMOLOGATION">Homologação</option><option value="PRODUCTION">Produção</option></Select>
      <Field label="CNPJ do estabelecimento" inputMode="numeric" value={draft.establishmentCnpj} onChange={event => set({ establishmentCnpj: event.target.value })} />
      <Field label="Código da loja/estabelecimento" value={draft.merchantCode} onChange={event => set({ merchantCode: event.target.value })} />
      <Field label="Número lógico (quando exigido)" value={draft.logicalNumber} onChange={event => set({ logicalNumber: event.target.value })} />
      <Field label="Terminal/PDV" value={draft.terminalId} onChange={event => set({ terminalId: event.target.value })} />
      <Field label="Caixa" value={draft.cashRegisterId} onChange={event => set({ cashRegisterId: event.target.value })} />
      <Field label="PinPad" value={draft.pinpad} onChange={event => set({ pinpad: event.target.value })} />
      {plain.map(field => field.options
        ? <Select key={field.key} label={field.label} value={draft.connection[field.key] ?? ''} onChange={event => set({ connection: { ...draft.connection, [field.key]: event.target.value } })}><option value="">Padrão</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</Select>
        : <Field key={field.key} label={field.label} placeholder={field.hint} value={draft.connection[field.key] ?? ''} onChange={event => set({ connection: { ...draft.connection, [field.key]: event.target.value } })} />)}
      {secret.map(field => <Field key={field.key} label={`${field.label}${provider.credentials[field.key] ? ' (já cadastrada — deixe em branco para manter)' : ''}`} type="password" autoComplete="new-password" value={draft.credentials[field.key] ?? ''} onChange={event => set({ credentials: { ...draft.credentials, [field.key]: event.target.value } })} />)}
    </div>
    <fieldset className="flex flex-wrap items-center gap-4 text-sm"><legend className="mb-1 text-sm font-medium text-slate-700">Formas de pagamento habilitadas</legend>
      {provider.capabilities.methods.map(method => <Check key={method} label={METHOD_LABEL[method] ?? method} checked={draft.enabledMethods.includes(method)} onChange={event => set({ enabledMethods: event.target.checked ? [...draft.enabledMethods, method] : draft.enabledMethods.filter(item => item !== method) })} />)}</fieldset>
    <div className="grid gap-4 md:grid-cols-4">
      <Field label="Bandeiras aceitas (separadas por vírgula)" value={draft.acceptedBrands} onChange={event => set({ acceptedBrands: event.target.value })} />
      <Select label="Papel do comprovante" value={draft.printing.paper} onChange={event => set({ printing: { ...draft.printing, paper: event.target.value } })}><option value="55mm">55 mm</option><option value="58mm">58 mm</option><option value="80mm">80 mm</option><option value="A4">A4</option></Select>
      <Field label="Vias" type="number" min="1" max="3" value={draft.printing.copies} onChange={event => set({ printing: { ...draft.printing, copies: Number(event.target.value) || 1 } })} />
      <div className="space-y-2 pt-6"><Check label="Imprimir comprovante automaticamente" checked={draft.printing.autoPrint} onChange={event => set({ printing: { ...draft.printing, autoPrint: event.target.checked } })} /><Check label="Permitir reimpressão" checked={draft.printing.allowReprint} onChange={event => set({ printing: { ...draft.printing, allowReprint: event.target.checked } })} /></div>
    </div>
    <fieldset className="space-y-2"><legend className="text-sm font-medium text-slate-700">Mapeamento financeiro (referência por forma de pagamento)</legend>
      <div className="grid gap-4 md:grid-cols-4">{provider.capabilities.methods.map(method => <Field key={method} label={METHOD_LABEL[method] ?? method} placeholder="Conta/categoria no financeiro" value={draft.financialMapping[method] ?? ''} onChange={event => set({ financialMapping: { ...draft.financialMapping, [method]: event.target.value } })} />)}</div>
      <p className="text-xs text-slate-500">Registro de referência para a conciliação e a auditoria. Os lançamentos continuam nascendo do pagamento aprovado e validado; este campo não cria lançamentos por conta própria.</p></fieldset>
    {!provider.simulated && <Field label="Evidência da homologação (obrigatória para marcar como homologada)" placeholder="Nº da certificação, data e responsável" value={draft.homologationEvidence} onChange={event => set({ homologationEvidence: event.target.value })} />}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void save()}>Salvar configuração</button>
      <button type="button" className={secondaryButtonClass} disabled={busy || provider.integrationStatus === 'NOT_CONFIGURED'} onClick={() => void test()}>Testar comunicação</button>
      {!provider.simulated && provider.integrationStatus === 'IN_TESTING' && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void save({ integrationStatus: 'HOMOLOGATED' })}>Marcar como homologada</button>}
      {!provider.simulated && provider.integrationStatus === 'HOMOLOGATED' && <button type="button" className={secondaryButtonClass} disabled={busy || draft.environment !== 'PRODUCTION'} onClick={() => void save({ integrationStatus: 'PRODUCTION_ENABLED' })}>Habilitar produção</button>}
    </div>
  </article>;
}

export function TefPanel() {
  const [section, setSection] = useState<Section>('providers');
  const [providers, setProviders] = useState<TefProvider[] | null>(null); const [registered, setRegistered] = useState(0);
  const [monitor, setMonitor] = useState<TefMonitor | null>(null); const [transactions, setTransactions] = useState<TefTransaction[]>([]);
  const [from, setFrom] = useState(monthStart); const [to, setTo] = useState(today); const [report, setReport] = useState<TefReconciliation | null>(null);
  const [events, setEvents] = useState<Array<{ id: string; createdAt: string; orderCode: string | null; provider: string; method: string; simulated: boolean; fromStatus: string | null; toStatus: string; note: string | null }>>([]);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null); const [busy, setBusy] = useState(false);
  const say = (text: string, kind: 'error' | 'success') => setNotice({ text, kind });

  const loadProviders = useCallback(async () => { try { const result = await api<{ items: TefProvider[]; registered: number }>('/tef/providers'); setProviders(result.items); setRegistered(result.registered); } catch (cause) { say(errorMessage(cause, 'Falha ao carregar os provedores'), 'error'); } }, []);
  const loadMonitor = useCallback(async () => { try { const [summary, list] = await Promise.all([api<TefMonitor>('/tef/monitor'), api<{ items: TefTransaction[] }>('/tef/transactions')]); setMonitor(summary); setTransactions(list.items); } catch (cause) { say(errorMessage(cause, 'Falha ao carregar o monitoramento'), 'error'); } }, []);
  const loadReport = useCallback(async () => {
    try { setReport(await api<TefReconciliation>(`/tef/reconciliation?${new URLSearchParams({ from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString() })}`)); } catch (cause) { say(errorMessage(cause, 'Falha ao carregar a conciliação'), 'error'); }
  }, [from, to]);
  const loadEvents = useCallback(async () => { try { setEvents((await api<{ items: typeof events }>('/tef/events')).items); } catch (cause) { say(errorMessage(cause, 'Falha ao carregar os eventos'), 'error'); } }, []);
  useEffect(() => { void loadProviders(); }, [loadProviders]);
  useEffect(() => { if (section === 'monitor') void loadMonitor(); if (section === 'reconciliation') void loadReport(); if (section === 'events') void loadEvents(); }, [section, loadMonitor, loadReport, loadEvents]);

  async function sync(transaction: TefTransaction) {
    setBusy(true);
    try { const result = await api<{ transaction: TefTransaction }>(`/tef/transactions/${transaction.id}/sync`, { method: 'POST' }); say(`Transação consultada no provedor: ${TEF_STATUS[result.transaction.status].label}.`, 'success'); await loadMonitor(); }
    catch (cause) { say(errorMessage(cause, 'Falha ao consultar'), 'error'); } finally { setBusy(false); }
  }
  async function cancel(transaction: TefTransaction) {
    const reason = window.prompt('Motivo do cancelamento/estorno (mínimo 5 caracteres):');
    if (!reason || reason.trim().length < 5) return;
    if (!window.confirm(`Estornar ${formatMoney(transaction.amount)} no provedor? O financeiro só muda depois da confirmação do provedor.`)) return;
    setBusy(true);
    try { const result = await api<{ fiscalWarning: string | null }>(`/tef/transactions/${transaction.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason, confirm: true }) }); say(`Transação estornada.${result.fiscalWarning ? ` ${result.fiscalWarning}` : ''}`, 'success'); await loadMonitor(); }
    catch (cause) { say(errorMessage(cause, 'Falha ao estornar'), 'error'); } finally { setBusy(false); }
  }
  async function recover() {
    setBusy(true);
    try { const result = await api<{ checked: number; approved: number; denied: number; closed: number; stillPending: number; failed: number }>('/tef/recover', { method: 'POST' }); say(result.checked === 0 ? 'Nenhuma transação pendente há mais de 1 minuto.' : `Recuperação: ${result.checked} consultada(s) — ${result.approved} aprovada(s), ${result.denied} negada(s), ${result.closed} encerrada(s), ${result.stillPending} ainda pendente(s), ${result.failed} sem resposta do provedor.`, 'success'); await loadMonitor(); }
    catch (cause) { say(errorMessage(cause, 'Falha na recuperação'), 'error'); } finally { setBusy(false); }
  }
  async function undo(transaction: TefTransaction) {
    const reason = window.prompt('Motivo do desfazimento (mínimo 5 caracteres):');
    if (!reason || reason.trim().length < 5) return;
    setBusy(true);
    try { const result = await api<{ outcome: string }>(`/tef/transactions/${transaction.id}/undo`, { method: 'POST', body: JSON.stringify({ reason, confirm: true }) }); say(result.outcome === 'UNDONE' ? 'Cobrança desfeita com confirmação do provedor.' : 'A transação já estava encerrada.', 'success'); await loadMonitor(); }
    catch (cause) { say(errorMessage(cause, 'Falha ao desfazer'), 'error'); await loadMonitor(); } finally { setBusy(false); }
  }
  async function receipt(transaction: TefTransaction, reprint: boolean) {
    let reason: string | undefined;
    if (reprint) { reason = window.prompt('Motivo da reimpressão (mínimo 5 caracteres):') ?? undefined; if (!reason || reason.trim().length < 5) return; }
    setBusy(true);
    try { const result = await api<{ deduplicated: boolean; printerFound: boolean }>(`/printing/receipts/tef/${transaction.id}`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }); say(!result.printerFound ? 'Comprovante enfileirado, mas não há impressora de cupom ativa: cadastre uma (tipo Cupom) e reenvie pela fila de impressão.' : result.deduplicated ? 'O comprovante original já foi enviado à impressora; use “Reimprimir” (com motivo) para outra via.' : 'Comprovante enviado para impressão.', result.printerFound ? 'success' : 'error'); }
    catch (cause) { say(errorMessage(cause, 'Falha ao imprimir o comprovante'), 'error'); } finally { setBusy(false); }
  }
  const count = (status: string) => monitor?.byStatus.find(row => row.status === status)?.count ?? 0;

  return <div className="space-y-4">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <Tabs tabs={[...sections]} value={section} onChange={setSection} label="Seções do TEF" />
    {section === 'providers' && (!providers ? <p className="text-sm text-slate-500">Carregando…</p> : providers.length === 0
      ? <EmptyState icon="🔌" title="Nenhum provedor TEF habilitado neste servidor" hint="Cada provedor (SiTef, PayGo, Stone, Cielo, Rede, Getnet…) exige adaptador próprio, SDK/API, credenciais, contrato e homologação. Implemente o adaptador conforme apps/api/src/lib/tef/adapter.ts e registre-o em providers.config.ts." />
      : <div className="space-y-6"><p className="text-sm text-slate-600">{registered} adaptador(es) disponível(is). Só aparecem os campos que se aplicam a cada provedor; credenciais são guardadas criptografadas e nunca exibidas. Um provedor só é “homologado” com evidência e teste de comunicação bem-sucedido.</p>
        {providers.map(provider => <ProviderCard key={provider.provider} provider={provider} onChanged={loadProviders} say={say} />)}</div>)}
    {section === 'monitor' && (!monitor ? <p className="text-sm text-slate-500">Carregando…</p> : <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4"><StatCard icon="✅" label="Aprovadas (30 dias)" value={count('APPROVED')} /><StatCard icon="⛔" label="Negadas" value={count('DENIED')} /><StatCard icon="⏳" label="Pendentes / sem resposta" value={count('PENDING') + count('TIMEOUT') + count('UNKNOWN')} tone="dark" /><StatCard icon="↩️" label="Estornadas" value={count('REVERSED')} /></div>
      <div className="flex justify-end"><button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void recover()}>Recuperar pendentes</button></div>
      {monitor.stale.length > 0 && <Notice message={`${monitor.stale.length} transação(ões) sem desfecho há mais de 5 minutos. Consulte o provedor antes de tentar cobrar de novo.`} />}
      {transactions.length === 0 ? <EmptyState title="Nenhuma transação TEF" /> : <DataTable columns={[{ label: 'Data' }, { label: 'Pedido' }, { label: 'Forma' }, { label: 'Valor', className: 'text-right' }, { label: 'NSU / Aut.' }, { label: 'Situação' }, { label: 'Ações' }]}>
        {transactions.map(item => <tr key={item.id}><td>{formatDateTime(item.requestedAt)}</td><td className="font-medium">{item.orderCode ?? item.orderId.slice(0, 8)}{item.simulated && <span className="ml-1"><Badge tone="amber">simulada</Badge></span>}</td>
          <td>{METHOD_LABEL[item.method] ?? item.method}{item.installments > 1 ? ` ${item.installments}x` : ''}{item.cardBrand ? ` · ${item.cardBrand}` : ''}</td><td className="text-right">{formatMoney(item.amount)}</td><td className="font-mono text-xs">{item.nsu ?? '—'} / {item.authorizationCode ?? '—'}</td>
          <td><Badge tone={TEF_STATUS[item.status].tone}>{TEF_STATUS[item.status].label}</Badge>{item.reversalInProgress && <span className="ml-1 text-xs text-amber-700">estorno em andamento</span>}</td>
          <td><div className="flex gap-2">{(['PENDING', 'TIMEOUT', 'UNKNOWN'].includes(item.status) || item.reversalInProgress) && <button className={secondaryButtonClass} disabled={busy} onClick={() => void sync(item)}>Consultar</button>}
            {['PENDING', 'TIMEOUT', 'UNKNOWN'].includes(item.status) && <button className={secondaryButtonClass} disabled={busy} onClick={() => void undo(item)}>Desfazer</button>}
            {item.status === 'APPROVED' && <><button className={secondaryButtonClass} disabled={busy} onClick={() => void receipt(item, false)}>Comprovante</button><button className={secondaryButtonClass} disabled={busy} onClick={() => void receipt(item, true)}>Reimprimir</button></>}
            {item.status === 'APPROVED' && !item.reversalInProgress && <button className={secondaryButtonClass} disabled={busy} onClick={() => void cancel(item)}>Estornar</button>}</div></td></tr>)}</DataTable>}</div>)}
    {section === 'events' && (events.length === 0 ? <EmptyState title="Nenhum evento TEF" /> : <DataTable columns={[{ label: 'Data' }, { label: 'Pedido' }, { label: 'Provedor' }, { label: 'Forma' }, { label: 'De → Para' }, { label: 'Detalhe' }]}>
      {events.map(item => <tr key={item.id}><td>{formatDateTime(item.createdAt)}</td><td>{item.orderCode ?? '—'}{item.simulated && <span className="ml-1"><Badge tone="amber">simulada</Badge></span>}</td><td>{item.provider}</td><td>{METHOD_LABEL[item.method] ?? item.method}</td><td>{item.fromStatus ? `${TEF_STATUS[item.fromStatus as keyof typeof TEF_STATUS]?.label ?? item.fromStatus} → ` : ''}{TEF_STATUS[item.toStatus as keyof typeof TEF_STATUS]?.label ?? item.toStatus}</td><td className="text-sm">{item.note ?? '—'}</td></tr>)}</DataTable>)}
    {section === 'reconciliation' && <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3"><Field label="De" type="date" value={from} onChange={event => setFrom(event.target.value)} /><Field label="Até" type="date" value={to} onChange={event => setTo(event.target.value)} /></div>
      {!report ? <p className="text-sm text-slate-500">Carregando…</p> : <>
        <Notice message={report.notice} />
        <div className="grid gap-3 md:grid-cols-3"><StatCard icon="⚠️" label="Divergências" value={report.divergences.length} tone="dark" /><StatCard icon="⏳" label="Sem desfecho" value={report.unresolved} /><StatCard icon="💳" label="Cartão/PIX lançados sem TEF" value={report.manualPayments} /></div>
        {report.totals.length > 0 && <DataTable columns={[{ label: 'Forma' }, { label: 'Bandeira' }, { label: 'Aprovadas', className: 'text-right' }, { label: 'Valor aprovado', className: 'text-right' }, { label: 'Estornadas', className: 'text-right' }, { label: 'Valor estornado', className: 'text-right' }, { label: 'Negadas', className: 'text-right' }]}>
          {report.totals.map(row => <tr key={`${row.method}${row.brand}`}><td>{METHOD_LABEL[row.method] ?? row.method}</td><td>{row.brand}</td><td className="text-right">{row.approved}</td><td className="text-right">{formatMoney(row.approvedAmount)}</td><td className="text-right">{row.reversed}</td><td className="text-right">{formatMoney(row.reversedAmount)}</td><td className="text-right">{row.denied}</td></tr>)}</DataTable>}
        {report.divergences.length === 0 ? <EmptyState icon="✅" title="Sem divergências no período" /> : <DataTable columns={[{ label: 'Tipo' }, { label: 'Pedido' }, { label: 'Detalhe' }]}>{report.divergences.map((row, index) => <tr key={index}><td><Badge tone="amber">{row.type}</Badge></td><td>{row.orderCode ?? '—'}</td><td>{row.detail}</td></tr>)}</DataTable>}
      </>}
    </div>}
  </div>;
}
