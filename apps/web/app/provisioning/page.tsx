'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime } from '../../lib/api';
import { AppShell, buttonClass, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';

type Provision = {
  id: string; tenantId: string; status: string; step: string; attempts: number; lastError: string | null;
  completedSteps: string[]; startedAt: string | null; completedAt: string | null; updatedAt: string;
  tenant: { id: string; name: string; slug: string; status: string; license: { status: string } | null; _count: { units: number; users: number } };
};
type Overview = { items: Provision[]; counts: { waiting: number; processing: number; errors: number; intervention: number } };
const labels: Record<string, string> = { WAITING: 'Aguardando', PROCESSING: 'Processando', COMPLETED: 'Concluído', ERROR: 'Erro', NEEDS_INTERVENTION: 'Necessita intervenção' };

export default function ProvisioningPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api<Overview>('/tenants/provisioning')); }
    catch (error) { setMessage(errorMessage(error, 'Falha ao carregar o monitor')); }
  }, []);
  useEffect(() => {
    let active = true;
    api<Overview>('/tenants/provisioning')
      .then(result => { if (active) setData(result); })
      .catch(error => { if (active) setMessage(errorMessage(error, 'Falha ao carregar o monitor')); });
    return () => { active = false; };
  }, []);
  async function retry(id: string) {
    setBusyId(id); setMessage('');
    try {
      await api(`/tenants/${id}/provision/retry`, { method: 'POST' });
      setSuccess(true); setMessage('Provisionamento retomado e conferido.'); await load();
    } catch (error) { setSuccess(false); setMessage(errorMessage(error, 'Provisionamento requer intervenção')); await load(); }
    finally { setBusyId(''); }
  }
  const countCards = data ? [
    ['Aguardando', data.counts.waiting], ['Processando', data.counts.processing],
    ['Com erro', data.counts.errors], ['Intervenção', data.counts.intervention],
  ] : [];
  return <AppShell title="Monitor de provisionamento">
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{countCards.map(([label, count]) => <article key={String(label)} className={panelClass}><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold">{count}</p></article>)}</section>
    <section className={panelClass}><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">Execuções recentes</h2><button className={secondaryButtonClass} onClick={() => void load()}>Atualizar</button></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr>{['Cliente', 'Estado', 'Etapa', 'Estrutura', 'Concluídas', 'Tentativas', 'Atualizado', 'Ação'].map(item => <th key={item} className="p-3">{item}</th>)}</tr></thead><tbody>
      {data?.items.map(item => <tr key={item.id} className="border-t border-slate-200 align-top"><td className="p-3"><strong>{item.tenant.name}</strong><div className="text-xs text-slate-500">{item.tenant.slug}</div></td><td className="p-3">{labels[item.status] ?? item.status}</td><td className="p-3">{item.step}</td><td className="p-3">{item.tenant._count.units} unidade(s), {item.tenant._count.users} usuário(s)</td><td className="max-w-72 p-3 text-xs text-slate-600">{item.completedSteps.join(' · ') || 'Nenhuma etapa registrada'}{item.lastError && <p className="mt-1 text-red-700">{item.lastError}</p>}</td><td className="p-3">{item.attempts}</td><td className="p-3">{formatDateTime(item.updatedAt)}</td><td className="p-3">{item.status !== 'COMPLETED' && <button className={buttonClass} disabled={busyId === item.tenantId} onClick={() => void retry(item.tenantId)}>{busyId === item.tenantId ? 'Verificando…' : 'Retomar'}</button>}</td></tr>)}
      {data?.items.length === 0 && <tr><td className="p-4 text-slate-500" colSpan={8}>Nenhum provisionamento registrado. Cadastros antigos sem monitor não são modificados.</td></tr>}
    </tbody></table></div></section>
  </AppShell>;
}
