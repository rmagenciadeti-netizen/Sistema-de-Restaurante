'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime, ListResponse, PrintAgent, PrintJob, Printer, ProductionSector } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

type Tab = 'sectors' | 'printers' | 'agents' | 'jobs';
const tabs: { id: Tab; label: string }[] = [{ id: 'sectors', label: 'Setores de produção' }, { id: 'printers', label: 'Impressoras' }, { id: 'agents', label: 'Agentes de impressão' }, { id: 'jobs', label: 'Fila de impressão' }];
const emptySector = { printer: '', name: '', code: '', color: '#3b82f6', description: '', sortOrder: '0', avgPrepMinutes: '', autoPrint: false, showOnKds: true, active: true };
const emptyPrinter = { name: '', kind: 'KITCHEN', connectionType: 'NETWORK', agentId: '', address: '', port: '9100', paperWidthMm: '80', sectorId: '', isPrimary: false, autoCut: true, cashDrawer: false, active: true };
const connectionLabel: Record<string, string> = { NETWORK: 'Rede', USB: 'USB', SHARED: 'Compartilhada', SERIAL: 'Serial', WINDOWS: 'Windows' };
const winKey = (agentId: string, name: string) => `${agentId}|${name}`;
const jobStatuses = ['PENDING', 'PRINTING', 'PRINTED', 'FAILED', 'CANCELLED'];
const jobStatusLabel: Record<string, string> = { PENDING: 'Pendente', PRINTING: 'Imprimindo', PRINTED: 'Impresso', FAILED: 'Falhou', CANCELLED: 'Cancelado' };

export default function ProductionPage() {
  const [tab, setTab] = useState<Tab>('sectors');
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [sectors, setSectors] = useState<ProductionSector[]>([]); const [printers, setPrinters] = useState<Printer[]>([]); const [agents, setAgents] = useState<PrintAgent[]>([]); const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [sectorForm, setSectorForm] = useState(emptySector); const [sectorId, setSectorId] = useState<string | null>(null);
  const [printerForm, setPrinterForm] = useState(emptyPrinter); const [printerId, setPrinterId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState(''); const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [jobFilter, setJobFilter] = useState('');
  // Printers installed in Windows, as reported by each active print agent.
  const windowsPrinters = agents.filter(agent => agent.active).flatMap(agent => (agent.printers ?? []).map(printer => ({ ...printer, agentId: agent.id, agentName: agent.name })));
  const agentName_ = (id?: string | null) => agents.find(agent => agent.id === id)?.name;
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function loadJobs(status = jobFilter) {
    try { setJobs((await api<ListResponse<PrintJob>>(`/printing/jobs${status ? `?status=${status}` : ''}`)).items); } catch (e) { fail(e, 'Erro ao carregar a fila de impressão'); }
  }
  async function load() {
    try {
      const [s, p, a] = await Promise.all([api<ListResponse<ProductionSector>>('/production/sectors'), api<ListResponse<Printer>>('/printing/printers'), api<ListResponse<PrintAgent>>('/printing/agents')]);
      setSectors(s.items); setPrinters(p.items); setAgents(a.items);
    } catch (e) { fail(e, 'Erro ao carregar produção e impressão'); }
    await loadJobs();
  }
  useAutoLoad(load);

  function editSector(item: ProductionSector) {
    setSectorId(item.id);
    const linked = printers.find(printer => printer.sectorId === item.id && printer.isPrimary) ?? printers.find(printer => printer.sectorId === item.id);
    setSectorForm({ printer: linked ? `p:${linked.id}` : '', name: item.name, code: item.code ?? '', color: item.color ?? '#3b82f6', description: item.description ?? '', sortOrder: String(item.sortOrder), avgPrepMinutes: item.avgPrepMinutes ? String(item.avgPrepMinutes) : '', autoPrint: item.autoPrint, showOnKds: item.showOnKds, active: item.active });
  }
  async function saveSector(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const body = { name: sectorForm.name, code: sectorForm.code || undefined, color: sectorForm.color || undefined, description: sectorForm.description || undefined, sortOrder: Number(sectorForm.sortOrder) || 0, avgPrepMinutes: sectorForm.avgPrepMinutes ? Number(sectorForm.avgPrepMinutes) : undefined, autoPrint: sectorForm.autoPrint, showOnKds: sectorForm.showOnKds, ...(sectorId ? { active: sectorForm.active } : {}) };
    try {
      const saved = await api<ProductionSector>(sectorId ? `/production/sectors/${sectorId}` : '/production/sectors', { method: sectorId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      await linkSectorPrinter(saved.id || sectorId!);
      ok(sectorId ? 'Setor atualizado.' : 'Setor criado.'); setSectorId(null); setSectorForm(emptySector); await load();
    } catch (e) { fail(e, 'Erro ao salvar setor'); }
  }
  // The sector's printer is a normal Printer row: an existing one is moved to the sector, a Windows printer is registered on the fly.
  async function linkSectorPrinter(id: string) {
    const choice = sectorForm.printer;
    if (!choice) return;
    if (choice.startsWith('p:')) {
      const current = printers.find(printer => printer.id === choice.slice(2));
      if (current && (current.sectorId !== id || !current.isPrimary)) await api(`/printing/printers/${current.id}`, { method: 'PATCH', body: JSON.stringify({ sectorId: id, isPrimary: true }) });
      return;
    }
    const picked = windowsPrinters.find(printer => winKey(printer.agentId, printer.name) === choice.slice(2));
    if (picked) await api('/printing/printers', { method: 'POST', body: JSON.stringify({ name: picked.name, kind: 'KITCHEN', connectionType: 'WINDOWS', address: picked.name, agentId: picked.agentId, paperWidthMm: 80, sectorId: id, isPrimary: true }) });
  }

  function editPrinter(item: Printer) {
    setPrinterId(item.id);
    setPrinterForm({ name: item.name, kind: item.kind, connectionType: item.connectionType, agentId: item.agentId ?? '', address: item.address ?? '', port: item.port ? String(item.port) : '', paperWidthMm: String(item.paperWidthMm), sectorId: item.sectorId ?? '', isPrimary: item.isPrimary, autoCut: item.autoCut, cashDrawer: item.cashDrawer, active: item.active });
  }
  async function savePrinter(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const windows = printerForm.connectionType === 'WINDOWS';
    if (windows && (!printerForm.address || !printerForm.agentId)) { setNotice({ text: 'Escolha a impressora do Windows na lista.', kind: 'error' }); return; }
    const body = { name: printerForm.name, kind: printerForm.kind, connectionType: printerForm.connectionType, agentId: windows ? printerForm.agentId : null, address: printerForm.address, port: !windows && printerForm.port ? Number(printerForm.port) : undefined, paperWidthMm: Number(printerForm.paperWidthMm), sectorId: printerForm.sectorId || null, isPrimary: printerForm.isPrimary, autoCut: printerForm.autoCut, cashDrawer: printerForm.cashDrawer, active: printerForm.active };
    try { await api(printerId ? `/printing/printers/${printerId}` : '/printing/printers', { method: printerId ? 'PATCH' : 'POST', body: JSON.stringify(body) }); ok(printerId ? 'Impressora atualizada.' : 'Impressora cadastrada.'); setPrinterId(null); setPrinterForm(emptyPrinter); await load(); } catch (e) { fail(e, 'Erro ao salvar impressora'); }
  }
  async function testPrinter(item: Printer) {
    try { await api(`/printing/printers/${item.id}/test`, { method: 'POST' }); ok(`Teste enviado para a fila da impressora ${item.name}.`); await loadJobs(); } catch (e) { fail(e, 'Erro ao enviar teste'); }
  }

  async function createAgent(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try { const created = await api<PrintAgent & { token: string }>('/printing/agents', { method: 'POST', body: JSON.stringify({ name: agentName }) }); setNewToken({ name: created.name, token: created.token }); setAgentName(''); await load(); } catch (e) { fail(e, 'Erro ao criar agente'); }
  }
  async function toggleAgent(item: PrintAgent) {
    try { await api(`/printing/agents/${item.id}`, { method: 'PATCH', body: JSON.stringify({ active: !item.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar agente'); }
  }
  async function copyToken() {
    try { await navigator.clipboard.writeText(newToken?.token ?? ''); ok('Token copiado para a área de transferência.'); } catch { setNotice({ text: 'Não foi possível copiar; selecione o token manualmente.', kind: 'error' }); }
  }

  async function retryJob(job: PrintJob) {
    try { await api(`/printing/jobs/${job.id}/retry`, { method: 'POST' }); ok('Trabalho reenviado para a fila.'); await loadJobs(); } catch (e) { fail(e, 'Erro ao reenviar trabalho'); }
  }

  const reportedAt = (ids: (string | null | undefined)[]) => agents.filter(agent => ids.includes(agent.id) && agent.printersReportedAt).map(agent => agent.printersReportedAt!).sort().pop();
  // Select with every printer installed in Windows on the computers running a print agent.
  function WindowsPrinterField() {
    const value = printerForm.agentId && printerForm.address ? winKey(printerForm.agentId, printerForm.address) : '';
    const known = windowsPrinters.some(printer => winKey(printer.agentId, printer.name) === value);
    return <div className="md:col-span-2">
      <Select label="Impressora do Windows" value={value} onChange={e => { const [agentId, ...rest] = e.target.value.split('|'); const name = rest.join('|'); setPrinterForm(current => ({ ...current, agentId: agentId ?? '', address: name, name: current.name || name })); }}>
        <option value="">{windowsPrinters.length ? 'Selecione a impressora' : 'Nenhuma impressora encontrada'}</option>
        {value && !known && <option value={value}>{printerForm.address} — {agentName_(printerForm.agentId) ?? 'agente'} (fora da lista)</option>}
        {windowsPrinters.map(printer => <option key={winKey(printer.agentId, printer.name)} value={winKey(printer.agentId, printer.name)}>{printer.name}{printer.isDefault ? ' (padrão)' : ''} — {printer.agentName}</option>)}
      </Select>
      <p className="mt-1 text-xs text-slate-500">{windowsPrinters.length ? `Lista enviada pelo agente de impressão${reportedAt(windowsPrinters.map(printer => printer.agentId)) ? ` (atualizada em ${formatDateTime(reportedAt(windowsPrinters.map(printer => printer.agentId)))})` : ''}. ` : 'Instale e inicie o agente de impressão no computador Windows (aba Agentes de impressão); ele envia a lista de impressoras instaladas em até 1 minuto. '}<button type="button" className="font-semibold text-brand-700 hover:text-brand-600" onClick={() => void load()}>Atualizar lista</button></p>
    </div>;
  }
  const sectorPrinterOptions = <>
    <option value="">Nenhuma</option>
    {printers.filter(printer => printer.active).map(printer => <option key={printer.id} value={`p:${printer.id}`}>{printer.name} — {connectionLabel[printer.connectionType]}{printer.sectorId && printer.sectorId !== sectorId ? ' (em outro setor)' : ''}</option>)}
    {windowsPrinters.filter(printer => !printers.some(registered => registered.connectionType === 'WINDOWS' && registered.agentId === printer.agentId && registered.address === printer.name)).map(printer => <option key={winKey(printer.agentId, printer.name)} value={`w:${winKey(printer.agentId, printer.name)}`}>{printer.name} — Windows ({printer.agentName})</option>)}
  </>;

  return <AppShell title="Produção e impressão">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <div className="mb-6 flex flex-wrap gap-2">{tabs.map(item => <button key={item.id} onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm ${tab === item.id ? 'bg-blue-600 text-white' : 'border border-slate-700 text-slate-300 hover:bg-slate-800'}`}>{item.label}</button>)}</div>

    {tab === 'sectors' && <>
      <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">{sectorId ? 'Editar setor' : 'Novo setor'}</h2>
        <form onSubmit={saveSector} className="grid gap-4 md:grid-cols-3">
          <Field label="Nome" required minLength={2} value={sectorForm.name} onChange={e => setSectorForm({ ...sectorForm, name: e.target.value })} />
          <Field label="Código" value={sectorForm.code} onChange={e => setSectorForm({ ...sectorForm, code: e.target.value })} />
          <Field label="Cor" type="color" value={sectorForm.color} onChange={e => setSectorForm({ ...sectorForm, color: e.target.value })} className="h-10 p-1" />
          <Field label="Ordem" type="number" min="0" max="1000" value={sectorForm.sortOrder} onChange={e => setSectorForm({ ...sectorForm, sortOrder: e.target.value })} />
          <Field label="Preparo médio (min)" type="number" min="1" max="600" value={sectorForm.avgPrepMinutes} onChange={e => setSectorForm({ ...sectorForm, avgPrepMinutes: e.target.value })} />
          <Field label="Descrição" maxLength={300} value={sectorForm.description} onChange={e => setSectorForm({ ...sectorForm, description: e.target.value })} />
          <Select label="Impressora do setor (inclui as do Windows)" value={sectorForm.printer} onChange={e => setSectorForm({ ...sectorForm, printer: e.target.value })}>{sectorPrinterOptions}</Select>
          <div className="flex flex-wrap items-center gap-4 md:col-span-3">
            <Check label="Imprimir automaticamente" checked={sectorForm.autoPrint} onChange={e => setSectorForm({ ...sectorForm, autoPrint: e.target.checked })} />
            <Check label="Exibir no KDS" checked={sectorForm.showOnKds} onChange={e => setSectorForm({ ...sectorForm, showOnKds: e.target.checked })} />
            {sectorId && <Check label="Ativo" checked={sectorForm.active} onChange={e => setSectorForm({ ...sectorForm, active: e.target.checked })} />}
            <button className={buttonClass}>{sectorId ? 'Salvar setor' : 'Adicionar setor'}</button>
            {sectorId && <button type="button" className={secondaryButtonClass} onClick={() => { setSectorId(null); setSectorForm(emptySector); }}>Cancelar edição</button>}
          </div>
        </form></section>
      <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Setores ({sectors.length})</h2><div className="grid gap-3 md:grid-cols-2">{sectors.map(item => <article key={item.id} className="rounded-lg border border-slate-800 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 font-semibold"><span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: item.color || '#64748b' }} />{item.name} {!item.active && <span className="text-xs text-red-300">inativo</span>}</h3><p className="mt-1 text-sm text-slate-400">{item.code || 'Sem código'} · ordem {item.sortOrder}{item.avgPrepMinutes ? ` · ~${item.avgPrepMinutes} min` : ''}</p><p className="mt-1 text-sm text-slate-400">{item.autoPrint ? 'Impressão automática' : 'Impressão manual'} · {item.showOnKds ? 'No KDS' : 'Fora do KDS'}</p>{printers.some(printer => printer.sectorId === item.id) && <p className="mt-1 text-sm text-slate-400">Impressora: {printers.filter(printer => printer.sectorId === item.id).map(printer => `${printer.name}${printer.connectionType === 'WINDOWS' ? ' (Windows)' : ''}`).join(', ')}</p>}{item.description && <p className="mt-1 text-sm text-slate-300">{item.description}</p>}</div><button className={secondaryButtonClass} onClick={() => editSector(item)}>Editar</button></div></article>)}</div>{sectors.length === 0 && <p className="text-slate-400">Nenhum setor cadastrado.</p>}</section>
    </>}

    {tab === 'printers' && <>
      <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">{printerId ? 'Editar impressora' : 'Nova impressora'}</h2>
        <form onSubmit={savePrinter} className="grid gap-4 md:grid-cols-3">
          <Field label="Nome" required minLength={2} value={printerForm.name} onChange={e => setPrinterForm({ ...printerForm, name: e.target.value })} />
          <Select label="Tipo" value={printerForm.kind} onChange={e => setPrinterForm({ ...printerForm, kind: e.target.value })}><option value="KITCHEN">Cozinha</option><option value="RECEIPT">Recibo / cupom / comprovante</option><option value="LABEL">Etiqueta</option></Select>
          <Select label="Conexão" value={printerForm.connectionType} onChange={e => setPrinterForm({ ...printerForm, connectionType: e.target.value })}><option value="NETWORK">Rede</option><option value="WINDOWS">Windows (impressoras instaladas)</option><option value="USB">USB</option><option value="SHARED">Compartilhada</option><option value="SERIAL">Serial</option></Select>
          {printerForm.connectionType === 'WINDOWS' ? WindowsPrinterField()
            : <><Field label="Endereço (IP, nome compartilhado ou porta)" maxLength={255} value={printerForm.address} onChange={e => setPrinterForm({ ...printerForm, address: e.target.value })} />
              <Field label="Porta" type="number" min="1" max="65535" value={printerForm.port} onChange={e => setPrinterForm({ ...printerForm, port: e.target.value })} /></>}
          <Select label="Papel" value={printerForm.paperWidthMm} onChange={e => setPrinterForm({ ...printerForm, paperWidthMm: e.target.value })}><option value="55">55 mm</option><option value="58">58 mm</option><option value="80">80 mm</option></Select>
          <Select label="Setor" value={printerForm.sectorId} onChange={e => setPrinterForm({ ...printerForm, sectorId: e.target.value })}><option value="">Sem setor</option>{sectors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
          <div className="flex flex-wrap items-center gap-4 md:col-span-3">
            <Check label="Principal do setor" checked={printerForm.isPrimary} onChange={e => setPrinterForm({ ...printerForm, isPrimary: e.target.checked })} />
            <Check label="Corte automático" checked={printerForm.autoCut} onChange={e => setPrinterForm({ ...printerForm, autoCut: e.target.checked })} />
            <Check label="Gaveta de dinheiro" checked={printerForm.cashDrawer} onChange={e => setPrinterForm({ ...printerForm, cashDrawer: e.target.checked })} />
            <Check label="Ativa" checked={printerForm.active} onChange={e => setPrinterForm({ ...printerForm, active: e.target.checked })} />
            <button className={buttonClass}>{printerId ? 'Salvar impressora' : 'Adicionar impressora'}</button>
            {printerId && <button type="button" className={secondaryButtonClass} onClick={() => { setPrinterId(null); setPrinterForm(emptyPrinter); }}>Cancelar edição</button>}
          </div>
        </form></section>
      <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Impressoras ({printers.length})</h2><div className="grid gap-3 md:grid-cols-2">{printers.map(item => <article key={item.id} className="rounded-lg border border-slate-800 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{item.name} {item.isPrimary && <span className="text-xs text-blue-300">principal</span>} {!item.active && <span className="text-xs text-red-300">inativa</span>}</h3><p className="mt-1 text-sm text-slate-400">{item.kind} · {connectionLabel[item.connectionType] ?? item.connectionType}{item.address ? ` · ${item.address}${item.port ? `:${item.port}` : ''}` : ''}{item.connectionType === 'WINDOWS' && agentName_(item.agentId) ? ` · ${agentName_(item.agentId)}` : ''}</p><p className="mt-1 text-sm text-slate-400">{item.paperWidthMm} mm · {item.sector?.name ?? 'Sem setor'}{item.autoCut ? ' · corte automático' : ''}{item.cashDrawer ? ' · gaveta' : ''}</p></div><div className="flex flex-col gap-2"><button className={secondaryButtonClass} onClick={() => editPrinter(item)}>Editar</button><button className={secondaryButtonClass} disabled={!item.active} onClick={() => void testPrinter(item)}>Imprimir teste</button></div></div></article>)}</div>{printers.length === 0 && <p className="text-slate-400">Nenhuma impressora cadastrada.</p>}</section>
    </>}

    {tab === 'agents' && <>
      {newToken && <div role="alert" className="mb-6 rounded-xl border border-amber-400/60 bg-amber-500/10 p-5"><h2 className="font-semibold text-amber-200">Token do agente “{newToken.name}”</h2><p className="mt-1 text-sm text-amber-100">Guarde este token agora: ele não será exibido novamente. Configure-o no agente de impressão instalado no computador do restaurante.</p><code className="mt-3 block select-all break-all rounded-lg bg-slate-950 p-3 text-sm text-white">{newToken.token}</code><div className="mt-3 flex gap-2"><button className={buttonClass} onClick={() => void copyToken()}>Copiar token</button><button className={secondaryButtonClass} onClick={() => setNewToken(null)}>Já guardei o token</button></div></div>}
      <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Novo agente de impressão</h2><form onSubmit={createAgent} className="grid gap-4 md:grid-cols-3"><Field label="Nome" required minLength={2} maxLength={100} value={agentName} onChange={e => setAgentName(e.target.value)} /><div className="flex items-end"><button className={buttonClass}>Criar agente</button></div></form></section>
      <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Agentes ({agents.length})</h2><div className="grid gap-3 md:grid-cols-2">{agents.map(item => <article key={item.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 p-4"><div><h3 className="font-semibold">{item.name} <span className={`text-xs ${item.active ? 'text-emerald-300' : 'text-red-300'}`}>{item.active ? 'ativo' : 'inativo'}</span></h3><p className="mt-1 text-sm text-slate-400">Último contato: {formatDateTime(item.lastSeenAt)}</p></div><button className={secondaryButtonClass} onClick={() => void toggleAgent(item)}>{item.active ? 'Desativar' : 'Ativar'}</button></article>)}</div>{agents.length === 0 && <p className="text-slate-400">Nenhum agente cadastrado.</p>}</section>
    </>}

    {tab === 'jobs' && <section className={panelClass}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><h2 className="text-lg font-semibold">Fila de impressão ({jobs.length})</h2><div className="flex items-end gap-2"><Select label="Status" value={jobFilter} onChange={e => { setJobFilter(e.target.value); void loadJobs(e.target.value); }}><option value="">Todos</option>{jobStatuses.map(status => <option key={status} value={status}>{jobStatusLabel[status]}</option>)}</Select><button className={secondaryButtonClass} onClick={() => void loadJobs()}>Atualizar</button></div></div>
      <div className="grid gap-3">{jobs.map(job => <article key={job.id} className="rounded-lg border border-slate-800 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{job.kind} <span className={`text-xs ${job.status === 'FAILED' ? 'text-red-300' : job.status === 'PRINTED' ? 'text-emerald-300' : 'text-slate-400'}`}>{jobStatusLabel[job.status] ?? job.status}</span></h3><p className="mt-1 text-sm text-slate-400">{job.printer?.name ?? 'Sem impressora'} · {job.sector?.name ?? 'Sem setor'} · {job.attempts} tentativa(s) · {formatDateTime(job.createdAt)}</p>{job.error && <p className="mt-1 text-sm text-red-300">Erro: {job.error}</p>}</div>{(job.status === 'FAILED' || job.status === 'CANCELLED') && <button className={secondaryButtonClass} onClick={() => void retryJob(job)}>Tentar novamente</button>}</div></article>)}</div>
      {jobs.length === 0 && <p className="text-slate-400">Nenhum trabalho de impressão.</p>}
    </section>}
  </AppShell>;
}
